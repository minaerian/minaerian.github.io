---
title: "The @batchSize(1) Pattern: When Parallel Deployment is Your Enemy in Azure"
date: 2026-01-11
draft: false
description: "Why BGP connections and DNS zones fail with 'AnotherOperationInProgress' errors when deployed in parallel, and how @batchSize(1) prevents race conditions."
tags: ["Azure", "Bicep", "BGP", "DNS", "Troubleshooting", "Infrastructure as Code"]
categories: ["Technical Deep Dive"]
series: ["Azure IaC Patterns"]
series_order: 1
---

## The Cryptic Error

Early in deploying our Azure Virtual WAN hub, DNS zone deployments started failing with:

```
Error: Another operation is in progress on the selected item
Code: AnotherOperationInProgress
```

No stack trace. No indication of what "another operation" was. The deployment just... stopped.

**The culprit?** Bicep's default parallel module deployment—something that usually makes deployments faster, but occasionally makes them fail in subtle, hard-to-debug ways.

## The Problem: Shared Backend State

Bicep deploys resources in loops **in parallel by default** for performance. For most resources, this is perfect. Deploy 10 storage accounts? Parallel is 10× faster than sequential.

But some Azure resources have **shared control plane state** that can't handle concurrent modifications:

### 1. BGP Connections in Virtual Hub

```bicep
// WRONG: Parallel deployment causes conflicts
module bgpConnections '../customModules/bgpConnections/main.bicep' = [
  for connection in bgpconnections_config.connections: {
    name: connection.name
    params: {
      name: connection.name
      hubVirtualNetworkConnectionId: vmx_vhub_link.outputs.resourceId
      peerAsn: connection.peerAsn
      peerIp: connection.peerIp
      vhubName: vmxhub.outputs.name
    }
  }
]
```

**What happens:**
- All BGP connections start establishing simultaneously
- Virtual Hub's BGP state machine tries to process multiple peer establishments
- State conflicts occur: "Peer A is being added" while "Peer B wants to modify routing table"
- Random failures with no clear indication of which peer caused the issue

### 2. Private DNS Zones and VNet Links

```bicep
// WRONG: Parallel deployment causes "operation in progress" errors
@batchSize(1)  // ← Missing this causes failures
module dnsZones '../customModules/privateDnsZone/main.bicep' = [
  for zone in private_dns_zones: {
    name: zone.name
    params: {
      name: zone.name
      virtualNetworkLinks: zone.vnets
    }
  }
]
```

**What happens:**
- Azure's DNS control plane serializes updates internally
- When you try to create multiple DNS zones in parallel, they all hit the same control plane
- Control plane says "I'm busy creating zone A, try again later"
- You get `AnotherOperationInProgress` even though they're **technically** independent resources

## The Solution: @batchSize(1)

Force sequential deployment with the `@sys.batchSize(1)` decorator:

```bicep
@sys.batchSize(1)  // ← Deploy one at a time
module bgpConnections '../customModules/bgpConnections/main.bicep' = [
  for connection in bgpconnections_config.connections: {
    name: '${connection.name}-${uniqueString(deployment().name, guid(subscription().id, connection.name))}'
    scope: resourceGroup(network_rg_config.targetSubscriptionId, network_rg_config.name)
    dependsOn: [ routingintent, vwan, vmxhub, meraki_vmx_1, meraki_vmx_2, vhub ]
    params: {
      name: connection.name
      hubVirtualNetworkConnectionId: vmx_vhub_link.outputs.resourceId
      peerAsn: connection.peerAsn
      peerIp: connection.peerIp
      vhubName: vmxhub.outputs.name
    }
  }
]
```

**What this does:**
1. Deploys `bgpConnections[0]`
2. **Waits** for it to complete
3. Deploys `bgpConnections[1]`
4. **Waits** for it to complete
5. Continues until all connections are established

## When to Use @batchSize(1)

Use sequential deployment for resources with **shared control plane state**:

### Networking

- ✅ BGP peer connections (Virtual Hub state machine)
- ✅ VNet peerings (when many peers connect to same hub)
- ✅ Route table associations (shared routing state)
- ✅ VPN connections to the same gateway

### DNS

- ✅ Private DNS zones (shared DNS control plane)
- ✅ DNS VNet links (multiple links to same zone)
- ✅ DNS records in rapid succession

### Identity

- ✅ Azure AD group memberships (when adding many users to same group)
- ✅ RBAC role assignments (when assigning to same resource)

### When NOT to Use It

❌ **Storage accounts** — Fully independent, parallel is fine
❌ **Virtual machines** — Independent resources, parallel is faster
❌ **Network Security Groups** — No shared state, parallel is safe
❌ **App Services** — Independent deployments, parallel preferred

## The Cost-Benefit Analysis

**Pro: Eliminates race conditions**
- No more `AnotherOperationInProgress` errors
- Predictable, reliable deployments
- Clear failure modes (one resource at a time)

**Con: Slower deployments**
- 5 BGP peers deployed sequentially: 5× longer than parallel
- For our hub: +10 minutes total deployment time

**Decision**: For production infrastructure, **reliability > speed**. An extra 10 minutes is acceptable if it means zero cryptic failures.

## Real Example: Our BGP Configuration

We deploy 5 BGP peer connections to our Virtual Hub for SD-WAN appliances:

```bicep
param bgpconnections_config = {
  connections: [
    { name: 'bgp-meraki-vmx-1-pri', peerAsn: 65001, peerIp: '10.255.0.68' },
    { name: 'bgp-meraki-vmx-1-sec', peerAsn: 65001, peerIp: '10.255.0.69' },
    { name: 'bgp-meraki-vmx-2-pri', peerAsn: 65002, peerIp: '10.255.0.132' },
    { name: 'bgp-meraki-vmx-2-sec', peerAsn: 65002, peerIp: '10.255.0.133' },
    { name: 'bgp-local-peer',       peerAsn: 65003, peerIp: '192.168.1.1' }
  ]
}
```

**Without `@batchSize(1)`**: Random failures on connections 3-5 with `Conflict` or `AnotherOperationInProgress`

**With `@batchSize(1)`**: 100% reliable deployments, every time

## How to Debug If You Hit This

If you're seeing `AnotherOperationInProgress` or `Conflict` errors:

1. **Check for loops** in your Bicep templates
2. **Identify shared state** — do the resources modify the same control plane?
3. **Add `@batchSize(1)`** to the loop
4. **Test deployment** — errors should disappear
5. **Document why** — future you (or your team) needs to know why it's sequential

## The Broader Lesson

**Not all resources in Bicep loops should deploy in parallel.**

When you're modifying **shared control plane state** (networking, DNS, routing, certain IAM operations), sequential deployment prevents conflicts that are **impossible to debug** from error messages alone.

The `@batchSize(1)` decorator is your tool for telling Bicep: "I know parallel would be faster, but these resources can't handle it—deploy one at a time."

---

**Next in series:** [Breaking Circular Dependencies: The DNAT Two-Phase Pattern](/posts/dnat-circular-dependency)

**Related:** [Gateway Orchestration in Virtual Hub](/posts/gateway-orchestration-azure)

*Part of the [13 Critical Azure IaC Patterns](/posts/azure-iac-patterns-series) series*
