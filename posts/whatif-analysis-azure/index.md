---
title: "Why Every Production Infrastructure Change Should Require What-If Analysis"
date: 2026-01-28
draft: false
description: "How Azure's what-if analysis prevents 'Why did 50 resources get recreated?' incidents by showing change impact before deployment."
tags: ["Azure", "Infrastructure as Code", "Bicep", "Change Management", "DevOps"]
categories: ["Best Practices"]
---

## Before What-If Analysis

**Team Slack, 2:47 AM:**
> "Why did the deployment recreate our entire VNet?"
> "Did we mean to delete that route table?"
> "Who approved this change?"

**The problem:** Infrastructure changes were invisible until they happened. By then, it was too late.

## After What-If Analysis

**Team Slack, 2:00 PM:**
> "What-if shows this will recreate the VNet. Is that expected?"
> "Looks like a parameter change forces replacement. Let me fix that."
> "What-if looks good - proceying with deployment."

**The difference:** Visibility **before** action prevents mistakes.

## What Azure What-If Does

Azure's `what-if` operation analyzes your Bicep/ARM templates and shows what would change:

```bash
az deployment sub what-if \
  --name Deploy_hub_Prod \
  --location westus \
  --template-file hub.bicep \
  --parameters hub.bicepparam
```

**Output:**
```
Resource changes: 47 to modify, 2 to create, 0 to delete.

~ Microsoft.Network/virtualNetworks/vnet-hub-prod [2023-11-01]
  - location: "westus"
  + location: "westus2"
  ! properties.addressSpace.addressPrefixes: [
    - "10.0.0.0/16"
    + "10.1.0.0/16"
    ]

+ Microsoft.Network/networkSecurityGroups/nsg-new-subnet [2023-11-01]

~ Microsoft.Network/azureFirewalls/fw-hub-prod [2023-11-01]
  ! properties.sku.tier:
    - "Standard"
    + "Premium"
```

**Legend:**
- `~` = Modify (in-place update)
- `+` = Create
- `-` = Delete
- `!` = Property change (shows before/after)

## Making What-If Mandatory

I added what-if as a required pipeline stage for all production deployments:

```yaml
# azure-pipelines-prod.yml

stages:
- stage: WhatIf
  displayName: 'What-If Analysis'
  condition: eq(variables['Build.SourceBranch'], 'refs/heads/main')
  jobs:
  - job: WhatIfAnalysis
    displayName: 'Run What-If Analysis'
    pool:
      vmImage: 'ubuntu-latest'

    steps:
    - task: AzureCLI@2
      displayName: 'What-If: Hub Infrastructure'
      inputs:
        azureSubscription: 'Azure-Prod-ServiceConnection'
        scriptType: 'bash'
        scriptLocation: 'inlineScript'
        inlineScript: |
          echo "Running what-if analysis..."

          az deployment sub what-if \
            --name Deploy_hub_Prod \
            --location westus \
            --template-file ./definitions/hub.bicep \
            --parameters ./parameters/hub.bicepparam \
            --result-format FullResourcePayloads \
            --no-pretty-print > whatif-output.txt

          # Check for destructive changes
          if grep -q "Delete" whatif-output.txt; then
            echo "⚠️  WARNING: This deployment will DELETE resources!"
            echo "Review the what-if output carefully."
          fi

          if grep -q "Create.*VirtualNetwork\|Delete.*VirtualNetwork" whatif-output.txt; then
            echo "🚨 CRITICAL: VNet changes detected!"
            echo "VNet recreation causes downtime. Verify this is intentional."
          fi

          # Display what-if output
          cat whatif-output.txt

    - task: PublishPipelineArtifact@1
      displayName: 'Publish What-If Results'
      inputs:
        targetPath: 'whatif-output.txt'
        artifact: 'whatif-analysis'

- stage: ManualApproval
  displayName: 'Approve Deployment'
  dependsOn: WhatIf
  jobs:
  - job: waitForValidation
    displayName: 'Wait for Manual Approval'
    pool: server
    timeoutInMinutes: 4320  # 3 days
    steps:
    - task: ManualValidation@0
      inputs:
        notifyUsers: 'cloud-team@example.com'
        instructions: 'Please review the what-if analysis and approve if changes look correct.'

- stage: Deploy
  displayName: 'Deploy to Production'
  dependsOn: ManualApproval
  jobs:
  - deployment: DeployProduction
    displayName: 'Deploy Infrastructure'
    environment: 'production'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureCLI@2
            displayName: 'Deploy Infrastructure'
            inputs:
              azureSubscription: 'Azure-Prod-ServiceConnection'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az deployment sub create \
                  --name Deploy_hub_Prod \
                  --location westus \
                  --template-file ./definitions/hub.bicep \
                  --parameters ./parameters/hub.bicepparam
```

## Real Example: Catching a Breaking Change

**What-If Output:**
```diff
~ Microsoft.Network/virtualNetworks/vnet-hub-prod
  ! properties.addressSpace.addressPrefixes: [
    - "10.0.0.0/16"
    + "10.1.0.0/16"
    ]

- Microsoft.Network/virtualNetworks/vnet-hub-prod/subnets/GatewaySubnet
+ Microsoft.Network/virtualNetworks/vnet-hub-prod/subnets/GatewaySubnet
```

**Translation:** Changing the address space will **delete and recreate the subnet**, which means:
- ❌ VPN Gateway will be deleted
- ❌ ExpressRoute will be disconnected
- ❌ 30-60 minutes of downtime

**Without What-If:** We'd discover this at 2 AM when users report VPN is down.

**With What-If:** We catch it during code review, realize this needs a maintenance window, and schedule appropriately.

## What-If Limitations

**What-If doesn't catch everything:**
- Runtime errors (e.g., name conflicts, quota limits)
- Policy violations (those fail at deployment time)
- Resource-specific constraints (e.g., VNet address space already in use)

**What-If is great at:**
- Showing what resources will change
- Catching unintended deletions/recreations
- Identifying configuration drift
- Validating parameter changes

## For Local Development

Run what-if before submitting PRs:

```bash
# what-if.sh
#!/bin/bash

echo "Running what-if analysis..."

az deployment sub what-if \
  --name "WhatIf-$(date +%Y%m%d-%H%M%S)" \
  --location westus \
  --template-file ./definitions/hub.bicep \
  --parameters ./parameters/hub-dev.bicepparam \
  --result-format ResourceIdOnly

echo ""
echo "Review the changes above. If they look correct, proceed with deployment."
```

## The Results

**Since making what-if mandatory:**
- ✅ 0 "surprise" resource recreations
- ✅ 100% of production changes reviewed before deployment
- ✅ Downtime planned proactively (not reactively)
- ✅ Change confidence increased dramatically

**Overhead:**
- What-if analysis: 30-60 seconds
- Manual review: 2-5 minutes
- Prevented incidents: Priceless

## The Lesson

**Visibility before action prevents mistakes. Make change impact visible before making changes irreversible.**

If you're deploying infrastructure without what-if analysis, you're flying blind. Add it to your CI/CD pipelines today.

---

**Related posts:**
- [Safety Guardrails for Production Systems](/posts/safety-guardrails-production)
- [Observability for Long-Running Deployments](/posts/observability-long-running-deployments)

*Part of a series on lessons learned managing enterprise Azure infrastructure at scale.*
