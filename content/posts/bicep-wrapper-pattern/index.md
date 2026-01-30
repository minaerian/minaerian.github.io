---
title: "The Wrapper Pattern: Building Stable Interfaces Over Azure Verified Modules"
date: 2026-01-16
draft: false
description: "How to use the Adapter pattern to create consistent, maintainable platform interfaces over third-party Bicep modules—handling SKU differences, runtime lookups, and module evolution."
tags: ["Azure", "Bicep", "Design Patterns", "Azure Verified Modules", "Architecture", "Platform Engineering"]
categories: ["Advanced Architecture", "Technical Deep Dive"]
series: ["Azure IaC Patterns"]
series_order: 4
---

## The Third-Party Module Problem

Azure Verified Modules (AVM) are Microsoft's official Bicep modules—thoroughly tested, maintained, and production-ready. We use them extensively:

```bicep
module vwan 'br/public:avm/res/network/virtual-wan:0.1.1' = { /* ... */ }
module vhub 'br/public:avm/res/network/virtual-hub:0.1.1' = { /* ... */ }
module fw 'br/public:avm/res/network/azure-firewall:0.8.0' = { /* ... */ }
```

But there's a challenge: **AVM modules have inconsistent output structures**, especially for runtime-assigned values like IP addresses.

For Azure Firewall specifically:
- Public IPs are nested in complex objects: `properties.hubIPAddresses.publicIPs.addresses[0].address`
- Private IPs differ between VNet SKU (`ipConfigurations[0].properties.privateIPAddress`) and vHub SKU (`hubIPAddresses.privateIPAddress`)
- Outputs don't provide convenient "first public IP" strings for DNAT rules

Every template consuming firewall IPs must handle object navigation, SKU conditionals, and array indexing.

## The Failed Approach: Direct AVM Consumption

Early implementation tried using AVM outputs directly:

```bicep
// WRONG: Complex, fragile, SKU-dependent
destinationAddresses: [
  fw.outputs.properties.hubIPAddresses.publicIPs.addresses[0].address  // ❌ Breaks if structure changes
]

dnsServers: [
  fw.outputs.properties.hubIPAddresses.privateIPAddress  // ❌ Only works for vHub SKU
]
```

**Problems:**

1. **Tight coupling** to AVM module internals
2. **SKU-specific logic** scattered across templates
3. **No null safety** if IPs aren't assigned yet
4. **Breaks when AVM updates** change output structure

Every template needs to know Azure Firewall's internal object structure. When AVM releases an update, **every template breaks**.

## The Solution: Wrapper + Helper Pattern

I created two abstraction layers using the **Adapter Pattern** from software engineering.

### Layer 1: The Helper (Runtime Lookup)

`helpers/firewallHelpers/get-azure-firewall-addresses.bicep`:

```bicep
@description('Existing Azure Firewall to read')
param firewallName string

@description('Subscription containing the firewall')
param firewallSubscriptionId string

@description('Resource group containing the firewall')
param firewallResourceGroup string

// Use 'existing' keyword to read deployed firewall properties
resource fw 'Microsoft.Network/azureFirewalls@2024-05-01' existing = {
  name: firewallName
  scope: resourceGroup(firewallSubscriptionId, firewallResourceGroup)
}

// Convenience locals (avoid for-loops over runtime values)
var hasIpConfs = contains(fw.properties, 'ipConfigurations') &&
                 length(fw.properties.ipConfigurations) > 0

var hasHubAddrs = contains(fw.properties, 'hubIPAddresses')

var hubAddrs = hasHubAddrs ? fw.properties.hubIPAddresses : null

var pubAddrsExists = hasHubAddrs &&
                     contains(hubAddrs.publicIPs, 'addresses') &&
                     length(hubAddrs.publicIPs.addresses) > 0

var pubAddrsRaw = pubAddrsExists ? hubAddrs.publicIPs.addresses : []

var firstPubAddr = pubAddrsExists ? first(pubAddrsRaw).address : ''

// Clean, simple outputs
@description('First public IP address (string). Good for DNAT.')
output publicIpFirst string = firstPubAddr

@description('Private IP when FW is VNet SKU (empty for vHub).')
output privateIpVnet string = hasIpConfs ?
  fw.properties.ipConfigurations[0].properties.privateIPAddress : ''

@description('Private IP when FW is vHub SKU (empty for VNet).')
output privateIpHub string = hasHubAddrs ? (hubAddrs.privateIPAddress ?? '') : ''

@description('All public IP addresses (array).')
output publicIpsAll array = pubAddrsRaw
```

**What this does:**
- Uses `existing` keyword to read deployed firewall properties
- Handles SKU differences (VNet vs vHub) internally with conditionals
- Provides null-safe navigation (`contains`, `??` operators)
- Returns **clean, simple outputs**: strings and arrays, not nested objects

### Layer 2: The Wrapper (Deployment + Standardization)

`avmWrappers/azure-firewall-wrapper.bicep`:

```bicep
@description('Firewall name')
param name string

@description('Location for all resources')
param location string

@description('Firewall policy resource ID')
param firewallPolicyId string

@description('Virtual Hub resource ID (empty for VNet SKU)')
param virtualHubResourceId string = ''

@description('Hub IP addresses configuration')
param hubIPAddresses object = {}

@description('Availability zones')
param availabilityZones array = []

@description('SKU tier (Standard or Premium)')
param azureSkuTier string

@description('Diagnostic settings')
param diagnosticSettings array = []

@description('Resource tags')
param tags object = {}

@description('Subscription and resource group for deployed firewall')
param targetSubscriptionId string
param targetResourceGroup string

//
// 1) Deploy the firewall using official AVM module
//
module fw 'br/public:avm/res/network/azure-firewall:0.8.0' = {
  name: '${name}-deploy'
  params: {
    name: name
    location: location
    firewallPolicyId: firewallPolicyId
    virtualHubResourceId: empty(virtualHubResourceId) ? '' : virtualHubResourceId
    hubIPAddresses: empty(virtualHubResourceId) ? null : hubIPAddresses
    availabilityZones: availabilityZones
    azureSkuTier: azureSkuTier
    diagnosticSettings: diagnosticSettings
    tags: tags
  }
}

//
// 2) Call helper to read runtime IPs after deployment
//
module fwAddrs '../helpers/firewallHelpers/get-azure-firewall-addresses.bicep' = {
  name: '${name}-addresses'
  params: {
    firewallName: fw.outputs.name
    firewallSubscriptionId: targetSubscriptionId
    firewallResourceGroup: targetResourceGroup
  }
}

//
// 3) Re-export clean, standardized outputs
//
@description('Firewall resource ID')
output resourceId string = fw.outputs.resourceId

@description('Firewall name')
output name string = fw.outputs.name

@description('First public IP (string). Good for DNAT translatedAddress.')
output fwPublicIp string = fwAddrs.outputs.publicIpFirst

@description('All public IPs (array).')
output fwPublicIps array = fwAddrs.outputs.publicIpsAll

@description('Private IP when using vHub SKU (empty for VNet).')
output fwPrivateIpHub string = fwAddrs.outputs.privateIpHub

@description('Private IP when using VNet SKU (empty for vHub).')
output fwPrivateIpVnet string = fwAddrs.outputs.privateIpVnet
```

**What this does:**

1. **Deploys firewall** using official AVM module (maintains all AVM benefits)
2. **Calls helper** to read runtime IPs (after deployment completes)
3. **Exports standardized outputs** that downstream templates expect

## Using the Wrapper in Hub Templates

In your main template, use the wrapper instead of AVM directly:

```bicep
module fw '../avmWrappers/azure-firewall-wrapper.bicep' = {
  name: '${fw_config.name}-${uniqueString(deployment().name)}'
  scope: resourceGroup(network_rg_config.targetSubscriptionId, network_rg_config.name)
  dependsOn: [ network_rg, fw_policy, vhub ]
  params: {
    name: fw_config.name
    azureSkuTier: fw_config.azureSkuTier
    firewallPolicyId: fw_policy.outputs.resourceId
    virtualHubResourceId: vhub.outputs.resourceId
    hubIPAddresses: { publicIPs: { count: 5 } }
    availabilityZones: [ '1', '2', '3' ]
    diagnosticSettings: fw_config.diagnosticSettings
    tags: fw_config.tags
    targetSubscriptionId: network_rg_config.targetSubscriptionId
    targetResourceGroup: network_rg_config.name
  }
}
```

Now consuming firewall outputs is **simple and SKU-agnostic**:

```bicep
// DNAT rule - just use the clean string output
destinationAddresses: [
  fw.outputs.fwPublicIp  // ✅ Clean, simple, works for any SKU
]

// DNS configuration - just use the string output
var fwDns = !empty(fw.outputs.fwPrivateIpHub) ?
  [ fw.outputs.fwPrivateIpHub ] : []

dnsServers: fwDns  // ✅ Safe, clean, handles null case
```

## The Architecture

This follows the **Adapter Pattern** from software engineering:

```
┌─────────────────────────────────────────────┐
│    Platform Templates (hub.bicep)           │
│    Consume clean, standardized interfaces   │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  avmWrappers (azure-firewall-wrapper)       │
│  Provide consistent output structure        │
└─────────────────┬───────────────────────────┘
                  │
         ┌────────┴────────┐
         ▼                 ▼
┌─────────────────┐  ┌────────────────────────┐
│   AVM Modules   │  │  helpers (runtime      │
│  (deployment)   │  │  value lookups)        │
└─────────────────┘  └────────────────────────┘
```

**Platform Templates** depend on wrappers, not directly on AVM or Azure resource schemas.

## Why This Architecture Matters

### Benefits

**1. Decouples from AVM internals**
- If AVM changes output structure, update the wrapper once (not 20 templates)
- Module version upgrades are isolated to wrapper layer
- Breaking changes don't cascade through codebase

**2. Encapsulates SKU complexity**
- VNet vs vHub logic lives in the helper, not scattered everywhere
- Add new SKU support in one place
- Consumers don't need to know which SKU they're using

**3. Provides semantic outputs**
- `fwPublicIp` is more meaningful than `outputs.properties.hubIPAddresses.publicIPs.addresses[0].address`
- Self-documenting interface reduces cognitive load
- Easier to review and understand code

**4. Enables null safety**
- Helper handles missing values gracefully (`contains`, `??`)
- Failed deployments don't leave templates with invalid references
- Retry scenarios work reliably

**5. Maintains AVM benefits**
- Still using official, tested modules for actual deployment
- Get security updates and bug fixes from Microsoft
- No need to reimplement firewall deployment logic

### Costs

- Additional abstraction layer (2 extra modules)
- Slightly more complex deployment graph
- More files to maintain

**Decision**: Maintainability and consistency outweigh simplicity for platform infrastructure used across multiple deployments.

## When to Use This Pattern

**Create wrappers when:**

1. **Output structure is complex** (nested objects, arrays, conditionals)
2. **Runtime values need post-processing** (extracting first IP, combining values)
3. **Multiple templates consume the same module** (DRY principle)
4. **Third-party module updates might break your code** (stability layer)
5. **SKU/configuration variations need abstraction**

**Don't create wrappers when:**

- Module outputs are already simple (strings, resource IDs)
- Used in only one place (over-engineering)
- No SKU/configuration variations to abstract
- Module is stable and unlikely to change

## Extending the Pattern

The same pattern applies to other Azure resources with complex outputs:

### Application Gateway

```bicep
// Wrapper handles:
- Public IP extraction
- Backend pool IDs
- Health probe outputs
- Frontend IP configuration
```

### Storage Account

```bicep
// Wrapper handles:
- Connection string generation
- Key retrieval
- Endpoint URLs (blob, file, queue, table)
- Container/share resource IDs
```

### Key Vault

```bicep
// Wrapper handles:
- Secret retrieval
- Certificate thumbprints
- Access policy outputs
- Diagnostic settings
```

## The Lesson

**Wrap third-party modules to create stable platform interfaces.**

AVM provides deployment capabilities. Helpers provide runtime value lookups. Wrappers tie them together into a **stable, semantic API** for your platform.

This three-layer architecture makes infrastructure code **maintainable at scale**:
- Consumers use simple, consistent interfaces
- Implementation details are encapsulated
- Evolution doesn't break dependent code

It's the difference between **writing templates** and **building a platform**.

---

**Related in series:**
- [Breaking Circular Dependencies](/posts/dnat-circular-dependency) - Uses wrapper outputs
- [Gateway Orchestration](/posts/gateway-orchestration-azure) - Shows orchestration with wrappers

*Part of the [13 Critical Azure IaC Patterns](/posts/azure-iac-patterns-series) series*
