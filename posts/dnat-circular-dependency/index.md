---
title: "Breaking the DNAT Circular Dependency: Two-Phase Deployment for Runtime-Assigned IPs"
date: 2026-01-13
draft: false
description: "How to deploy Azure Firewall DNAT rules that require runtime-assigned public IPs using multi-phase deployments and explicit dependency ordering."
tags: ["Azure", "Bicep", "Azure Firewall", "DNAT", "Circular Dependency", "Infrastructure as Code"]
categories: ["Problem Solving", "Azure Architecture"]
series: ["Azure IaC Patterns"]
series_order: 2
---

## The Chicken-and-Egg Problem

Here's a dependency puzzle that stumped me for hours:

- **Firewall needs** a policy to be created
- **DNAT rules need** the firewall's **public IP** to set destination addresses
- **The firewall's public IP** isn't known until **after** the firewall is deployed
- **But DNAT rules** must be in the **firewall policy**

Welcome to Azure's secure Virtual Hub firewalls, where public IPs are assigned **at deployment time** and can't be predetermined.

## The Failed Approach

My first attempt looked like this:

```bicep
// WRONG: This creates a circular dependency
param fwpolicy_config = {
  ruleCollectionGroups: [
    {
      name: 'DNAT-rules'
      ruleCollections: [
        {
          rules: [
            {
              destinationAddresses: [
                fw.outputs.fwPublicIp  // ❌ Circular dependency!
              ]
              translatedAddress: '10.0.1.5'
              translatedPort: 3389
            }
          ]
        }
      ]
    }
  ]
}

module fw_policy 'br/public:avm/res/network/firewall-policy:0.1.2' = {
  name: 'firewall-policy'
  params: {
    name: 'fw-policy-prod'
    ruleCollectionGroups: fwpolicy_config.ruleCollectionGroups
  }
}

module fw 'azure-firewall-wrapper.bicep' = {
  dependsOn: [ fw_policy ]  // ← Policy needs firewall IP, firewall needs policy
  params: {
    firewallPolicyId: fw_policy.outputs.resourceId
  }
}
```

**Azure returns:** `Circular dependency detected between 'fw' and 'fw_policy'`

## Why This Happens

Bicep's dependency graph:
```
fw_policy
   ↓ (depends on fw.outputs.fwPublicIp)
   fw
   ↓ (depends on fw_policy.outputs.resourceId)
fw_policy  ← LOOP!
```

You can't deploy the policy without the firewall IP, and you can't deploy the firewall without the policy.

## The Solution: Two-Phase Deployment

Break the circular dependency by deploying in two phases:

### Phase 1: Deploy Firewall Policy WITHOUT DNAT Rules

```bicep
module fw_policy 'br/public:avm/res/network/firewall-policy:0.1.2' = {
  name: '${fwpolicy_config.name}-${uniqueString(deployment().name)}'
  scope: resourceGroup(network_rg_config.targetSubscriptionId, network_rg_config.name)
  dependsOn: [ network_rg ]
  params: {
    name: fwpolicy_config.name
    threatIntelMode: 'Deny'

    // Include network rules and application rules, but NO DNAT
    ruleCollectionGroups: fwpolicy_config.ruleCollectionGroups  // No DNAT rules here

    // TLS inspection, IDPS, threat intelligence settings
    intrusionDetection: {
      mode: 'Alert'
      configuration: { /* ... */ }
    }
  }
}
```

### Phase 2: Deploy Firewall

```bicep
module fw '../avmWrappers/azure-firewall-wrapper.bicep' = {
  name: '${fw_config.name}-${uniqueString(deployment().name)}'
  scope: resourceGroup(network_rg_config.targetSubscriptionId, network_rg_config.name)
  dependsOn: [ network_rg, fw_policy, vhub ]
  params: {
    name: fw_config.name
    azureSkuTier: 'Premium'
    firewallPolicyId: fw_policy.outputs.resourceId  // ✅ Policy exists from Phase 1
    virtualHubResourceId: vhub.outputs.resourceId
    hubIPAddresses: { publicIPs: { count: 5 } }
  }
}
```

**At this point:** Firewall is deployed and has a public IP accessible via `fw.outputs.fwPublicIp`

### Phase 3: Add DNAT Rules AFTER Firewall Exists

```bicep
module fw_dnat_rule_collection '../customModules/firewall-policy/rule-collection-group/main.bicep' = {
  name: '${fw_dnat_rule_collection_config.name}-${uniqueString(deployment().name)}'
  scope: resourceGroup(network_rg_config.targetSubscriptionId, network_rg_config.name)

  // CRITICAL: Wait for routing intent to complete
  dependsOn: [ routingintent ]  // ← Not just fw, but routingintent!

  params: {
    firewallPolicyName: fw_policy.outputs.name
    name: fw_dnat_rule_collection_config.name
    priority: 100

    ruleCollections: [
      {
        name: 'rdp-dnat-rules'
        priority: 100
        ruleCollectionType: 'FirewallPolicyNatRuleCollection'
        action: { type: 'DNAT' }
        rules: [
          {
            name: 'allow-rdp-dc1'
            ruleType: 'NatRule'
            sourceAddresses: [ '*' ]
            destinationPorts: [ '3389' ]
            ipProtocols: [ 'TCP' ]

            // ✅ Now we have the firewall's public IP!
            destinationAddresses: [
              fw.outputs.fwPublicIp
            ]

            translatedAddress: '10.0.1.5'
            translatedPort: '3389'
          }
        ]
      }
    ]
  }
}
```

## The Critical Dependency: Routing Intent

Notice the `dependsOn: [ routingintent ]`. This isn't obvious, but it's **essential**.

Here's why:

1. **Firewall deploys** (gets public IP)
2. **Routing Intent** configures the firewall as the hub's next hop for Internet/Private traffic
3. During routing intent deployment, the firewall enters a **provisioning state**
4. If you try to update the firewall policy **during** routing intent provisioning, the update fails with `Conflict`

**The dependency chain must be:**
```
fw_policy (no DNAT) → fw → routingintent → fw_dnat_rule_collection
```

**Not:**
```
fw_policy (no DNAT) → fw → fw_dnat_rule_collection  ← FAILS with Conflict
```

## The Parameter File Pattern

In your parameter file, the DNAT config intentionally has **empty** destination addresses:

```bicep
// parameters/hub.bicepparam

param fw_dnat_rule_collection_config = {
  name: 'dnat-rule-collection-group'
  ruleCollections: [
    {
      name: 'rdp-dnat-rules'
      rules: [
        {
          name: 'allow-rdp-dc1'
          destinationAddresses: [
            // ← Intentionally empty!
            // Will be populated at runtime in hub.bicep with fw.outputs.fwPublicIp
          ]
          destinationPorts: [ '3389' ]
          translatedAddress: '10.0.1.5'
          translatedPort: '3389'
        }
      ]
    }
  ]
}
```

The actual IP is injected in the template **after** the firewall deploys:

```bicep
destinationAddresses: [ fw.outputs.fwPublicIp ]
```

## Why This Pattern Works

**Breaks the circular dependency:**
- Policy can deploy without knowing firewall IP
- Firewall can deploy with existing policy
- DNAT rules added after both exist

**Handles runtime-assigned values:**
- Firewall IP is only known after deployment
- Multi-phase pattern allows passing runtime values forward

**Ensures stability:**
- Waiting for routing intent prevents `Conflict` errors
- DNAT rules are the **last** networking operation

## When to Use This Pattern

Use two-phase deployment whenever:

1. **Runtime-assigned values** (IPs, resource IDs, keys) are needed in configuration
2. **Circular dependencies** exist between resources
3. **Provisioning states** prevent immediate configuration (like routing intent)
4. **Order matters** but can't be expressed in simple `dependsOn`

## The Wrapper Module

You might have noticed `fw.outputs.fwPublicIp` in the code. This comes from our firewall wrapper module that extracts the IP from Azure's complex output structure:

```bicep
// avmWrappers/azure-firewall-wrapper.bicep
module fw 'br/public:avm/res/network/azure-firewall:0.8.0' = {
  name: '${name}-deploy'
  params: { /* ... */ }
}

module fwAddrs '../helpers/firewallHelpers/get-azure-firewall-addresses.bicep' = {
  name: '${name}-addresses'
  params: {
    firewallName: fw.outputs.name
  }
}

output fwPublicIp string = fwAddrs.outputs.publicIpFirst
```

The wrapper handles the complexity of extracting IPs from Azure's nested objects. See [The Wrapper Pattern](/posts/bicep-wrapper-pattern) for details.

## The Broader Lesson

**Runtime-assigned values break declarative IaC.**

When Azure assigns values at deployment time (IPs, resource IDs, keys), you need **multi-phase deployments** with:
- Explicit ordering (`dependsOn`)
- Output passing between phases
- Understanding of resource provisioning states

DNAT rules are just one example. The pattern applies to:
- Application Gateway backends needing VM IPs
- DNS records needing Public IP addresses
- Connection strings needing database endpoints
- Webhooks needing Function App URLs

Anytime you need a value that doesn't exist until after deployment, consider two-phase deployment.

---

**Next in series:** [Gateway Orchestration: Why Order Matters in Virtual Hub](/posts/gateway-orchestration-azure)

**Related:** [The @batchSize(1) Pattern](/posts/bicep-batchsize-pattern)

*Part of the [13 Critical Azure IaC Patterns](/posts/azure-iac-patterns-series) series*
