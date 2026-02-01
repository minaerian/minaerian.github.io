---
title: "Parameterization is an Art: Finding the Balance in Infrastructure as Code"
date: 2026-01-18
draft: false
description: "Lessons learned managing 6 parameter files averaging 1,500+ lines each: when to abstract, when to be explicit, and how to keep it maintainable."
tags: ["Infrastructure as Code", "Bicep", "Architecture", "Best Practices"]
categories: ["Technical Deep Dive"]
---

## The Parameterization Problem

I maintain 6 parameter files for our Azure infrastructure. Each file is 1,500+ lines. That's **9,000+ lines of configuration** for 6 environments (dev, prod, drdev, drprod across different business units).

Early on, I made every parameterization mistake possible:
- Too generic → "What's actually in this object?"
- Too specific → "I have to add 50 lines to create one firewall rule?"
- Inconsistent → "Why does VNet config work differently than NSG config?"

Managing 1,200+ files of IaC taught me: **parameterization is an art, not a science.**

## Anti-Pattern 1: The Black Box Object

**Too Generic:**
```bicep
@description('Configuration object')
param config object

resource firewall 'Microsoft.Network/azureFirewalls@2023-11-01' = {
  name: config.name
  location: config.location
  properties: config.properties  // What's in here??? No one knows.
}
```

**Problems:**
- No intellisense
- No type safety
- Can't discover valid properties without reading implementation
- Changes break silently

**When you open the parameter file:**
```json
{
  "config": {
    "name": "fw-hub-prod",
    "location": "westus",
    "properties": {
      // 300 lines of nested objects...
    }
  }
}
```

You have no idea what's valid. You copy-paste from docs and hope.

## Anti-Pattern 2: The Explosion of Parameters

**Too Specific:**
```bicep
param firewall_name string
param firewall_location string
param firewall_sku_name string
param firewall_sku_tier string
param firewall_rule_1_name string
param firewall_rule_1_priority int
param firewall_rule_1_source string
param firewall_rule_1_destination string
// ...repeat 50 times for all rules
```

**Problems:**
- Unmanageable parameter lists (100+ parameters)
- Hard to add new resources (20+ new parameters)
- Copy-paste errors everywhere
- Parameter file is 3,000+ lines of primitives

## The Sweet Spot: Scoped Parameter Objects

**Just Right:**
```bicep
@description('Azure Firewall configuration')
param firewall_config object

@description('Firewall policy and rules configuration')
param fwpolicy_config object

@description('VNet configuration for identity network')
param identity_vnet_config object

@description('Virtual WAN routing intent configuration')
param routingintent_config object
```

**Why this works:**
- Each object is clearly scoped to a logical component
- Component boundaries match Azure resource boundaries
- Still flexible, but discoverable
- Parameter files organized by infrastructure layer

**In the parameter file:**
```json
{
  "firewall_config": {
    "name": "fw-hub-prod",
    "location": "westus",
    "sku": {
      "name": "AZFW_Hub",
      "tier": "Premium"
    },
    "threatIntelMode": "Alert",
    "zones": ["1", "2", "3"]
  },
  "fwpolicy_config": {
    "name": "fwpolicy-hub-prod",
    "threatIntelMode": "Deny",
    "rules": [
      {
        "name": "allow-internal-dns",
        "priority": 100,
        "ruleType": "NetworkRule",
        "action": "Allow",
        "sourceAddresses": ["10.0.0.0/8"],
        "destinationAddresses": ["168.63.129.16"],
        "destinationPorts": ["53"],
        "ipProtocols": ["UDP"]
      }
    ]
  }
}
```

**Readable, structured, and maps to Azure concepts.**

## Pattern: Document Your Parameter Objects

Add inline documentation:

```bicep
/*
  Firewall Configuration Object Structure:
  {
    name: string              // Firewall resource name
    location: string          // Azure region
    sku: {
      name: 'AZFW_Hub'       // Must be AZFW_Hub for Virtual WAN
      tier: 'Standard'|'Premium'
    }
    threatIntelMode: 'Alert'|'Deny'|'Off'
    zones: string[]           // Availability zones (e.g., ["1","2","3"])
  }
*/
@description('Azure Firewall configuration')
param firewall_config object
```

## Pattern: Validation Where It Matters

```bicep
@description('Environment name')
@allowed(['dev', 'prod', 'drdev', 'drprod'])
param environment string

@description('Azure region for primary resources')
@allowed(['westus', 'eastus', 'westus2', 'eastus2'])
param location string

@description('VNet address space (CIDR notation)')
@minLength(9)
@maxLength(18)
param vnet_address_space string
```

Catches errors at authoring time, not deployment time.

## Pattern: Defaults for Common Values

```bicep
@description('Resource tags')
param tags object = {
  ManagedBy: 'Infrastructure Team'
  DeploymentMethod: 'Bicep'
  Environment: environment
  CostCenter: 'IT-Infrastructure'
}

@description('Diagnostic settings retention days')
@minValue(30)
@maxValue(365)
param diagnostics_retention_days int = 90
```

Reduces parameter file size while allowing overrides.

## Real Example: Hub Configuration

**hub.bicep parameters:**
```bicep
param environment string
param location string
param vwan_config object
param firewall_config object
param fwpolicy_config object
param vpn_gateway_config object
param er_gateway_config object
param identity_vnet_config object
param bastion_config object
```

**8 parameters** for a hub deployment with 40+ resources. Each parameter maps to a logical component.

**hub-prod.bicepparam (excerpt):**
```bicep
using './hub.bicep'

param environment = 'prod'
param location = 'westus'

param vwan_config = {
  name: 'vwan-hub-prod'
  type: 'Standard'
  allowBranchToBranchTraffic: true
  hub: {
    name: 'vhub-westus-prod'
    addressPrefix: '10.255.0.0/23'
  }
}

param firewall_config = {
  name: 'fw-hub-prod'
  sku: { name: 'AZFW_Hub', tier: 'Premium' }
  threatIntelMode: 'Deny'
  zones: ['1', '2', '3']
}
// ...
```

Clean, organized, maintainable.

## The Lessons

**Good parameterization:**
1. **Scoped**: Parameters map to logical infrastructure components
2. **Documented**: Inline comments explain structure and valid values
3. **Validated**: Use `@allowed`, `@minValue`, etc. where meaningful
4. **Defaulted**: Common values have sensible defaults
5. **Consistent**: Similar resources use similar parameter structures

**Bad parameterization:**
- Makes you read implementation code to understand parameters
- Requires 100+ parameters for simple deployments
- Changes structure inconsistently across resources
- Provides no validation or documentation

**Remember:** Good abstraction makes complex systems manageable. Bad abstraction just hides complexity until it explodes.

---

**Related posts:**
- [Hub-and-Spoke Deployment Orchestration](/posts/hub-spoke-deployment-orchestration)
- [Observability for Long-Running Deployments](/posts/observability-long-running-deployments)

*Part of a series on lessons learned managing 1,200+ files of Azure Infrastructure as Code at enterprise scale.*
