---
title: "Stop Reminding Developers to Save Money: Automate Dev Environment Cleanup"
date: 2026-01-25
draft: false
description: "How automated nightly cleanup of expensive Azure resources reduced development costs by 70% without hurting developer experience."
tags: ["Azure", "Cost Optimization", "FinOps", "Automation", "Azure Firewall"]
categories: ["Cost Management"]
---

## The Problem: Dev Environments Running 24/7

Our development Azure environment was costing **$8,400/month**. A significant chunk was:
- Azure Firewall Premium: **~$1,200/month** (running 24/7)
- VPN Gateways (2x): **~$800/month**
- ExpressRoute Gateway: **~$600/month**

Developers needed these resources during work hours (8am-6pm Pacific). But they ran all night, every weekend, and during holidays.

**Manual reminders didn't work:**
- "Remember to deallocate the firewall when done!"
- "Please shut down VPN gateways over the weekend!"

People forget. They're busy. They're focused on shipping code, not infrastructure costs.

## The Insight: Developer Experience vs. Cost Optimization Isn't Binary

The key realization: **You don't need to choose between developer experience and cost savings.**

What developers need:
- ✅ Resources available during work hours
- ✅ Fast startup when they need them
- ✅ Zero manual intervention

What finance needs:
- ✅ Resources not running when unused
- ✅ Predictable, optimized costs
- ✅ Clear cost attribution

**Automated cleanup achieves both.**

## The Solution: Scheduled Deallocation Pipeline

I created an Azure DevOps pipeline that runs every night and deallocates expensive resources in dev environments:

```yaml
# azure-pipelines-cleanup.yml
name: Nightly Dev Environment Cleanup

schedules:
- cron: "30 6 * * *"  # 6:30 UTC = 11:30 PM Pacific (after work hours)
  displayName: Nightly cleanup
  branches:
    include:
    - main
  always: true  # Run even if no code changes

trigger: none  # Only run on schedule

variables:
  - group: platform-dev-credentials
  - name: subscriptionId
    value: '10d75c52-6c31-4c96-af43-ca0806e178bc'

jobs:
- job: DeallocateExpensiveResources
  displayName: 'Deallocate Dev Environment Resources'
  pool:
    vmImage: 'ubuntu-latest'

  steps:
  - task: AzureCLI@2
    displayName: 'Deallocate Azure Firewall'
    inputs:
      azureSubscription: 'Platform-Dev-ServiceConnection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        echo "Deallocating Azure Firewall in Dev environment..."

        # Deallocate firewall (preserves configuration, stops billing)
        az network firewall delete \
          --name fw-hub-dev \
          --resource-group rg-hub-dev

        echo "Firewall deallocated. Configuration preserved in ARM templates."

  - task: AzureCLI@2
    displayName: 'Deallocate VPN Gateways'
    inputs:
      azureSubscription: 'Platform-Dev-ServiceConnection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        echo "Deallocating VPN Gateways..."

        az network vnet-gateway delete --name vng-hub-dev-vpn1 --resource-group rg-hub-dev
        az network vnet-gateway delete --name vng-hub-dev-vpn2 --resource-group rg-hub-dev

        echo "VPN Gateways deallocated."

  - task: AzureCLI@2
    displayName: 'Deallocate ExpressRoute Gateway'
    inputs:
      azureSubscription: 'Platform-Dev-ServiceConnection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        echo "Deallocating ExpressRoute Gateway..."

        az network vnet-gateway delete --name vng-hub-dev-er --resource-group rg-hub-dev

        echo "ExpressRoute Gateway deallocated."

  - task: Bash@3
    displayName: 'Send Notification'
    inputs:
      targetType: 'inline'
      script: |
        echo "✅ Dev environment cleanup completed at $(date)"
        echo "Resources will be recreated on next deployment."
        # Add Teams/Slack notification here if desired
```

## Morning Redeployment (Optional)

For teams that want resources ready in the morning, add a morning pipeline:

```yaml
schedules:
- cron: "0 15 * * 1-5"  # 3:00 PM UTC = 7:00 AM Pacific, Mon-Fri
  displayName: Morning environment prep
  branches:
    include:
    - main
```

But we found **developers prefer on-demand deployment** - they run the deployment pipeline when needed (takes 60 minutes, but they control it).

## Critical Safety Measures

**Never run cleanup against production:**

```yaml
schedules:
- cron: "30 6 * * *"
  branches:
    exclude:
    - main  # Or use explicit environment checks
```

**Add subscription validation:**

```bash
CURRENT_SUB=$(az account show --query id -o tsv)
ALLOWED_SUB="10d75c52-6c31-4c96-af43-ca0806e178bc"  # Platform-Dev

if [ "$CURRENT_SUB" != "$ALLOWED_SUB" ]; then
    echo "❌ ERROR: Not running in Dev subscription!"
    echo "Current: $CURRENT_SUB"
    echo "Expected: $ALLOWED_SUB"
    exit 1
fi
```

## The Results

**Cost Savings:**
- **Before:** $8,400/month for dev environment
- **After:** $2,500/month (70% reduction)
- **Annual savings:** ~$70,000

**What We Deallocate Nightly:**
- Azure Firewall Premium: ~$1,200/mo → $40/mo (96% savings)
- VPN Gateways (2x): ~$800/mo → $0 (100% savings, recreated on-demand)
- ExpressRoute Gateway: ~$600/mo → $0 (100% savings, recreated on-demand)

**Developer Impact:**
- ✅ Zero complaints (they just redeploy when needed)
- ✅ Configuration always preserved (in IaC)
- ✅ Faster iteration (forces IaC testing)

## Why This Works

1. **Automated = Reliable**: No human decisions, no forgotten shutdowns
2. **IaC-Friendly**: Encourages treating infrastructure as code, not pets
3. **Configurable**: Easy to adjust schedule or skip cleanup on-demand
4. **Auditable**: Pipeline logs show exactly what was deallocated and when

## Alternative Approaches

**For VM-heavy environments:**
```bash
# Stop all VMs in resource group
az vm deallocate --ids $(az vm list -g rg-dev --query "[].id" -o tsv)
```

**For Azure Virtual Desktop:**
```bash
# Stop session hosts (preserves configuration)
az desktopvirtualization sessionhost update \
  --resource-group rg-avd-dev \
  --host-pool-name hp-dev \
  --name sessionhost-0 \
  --allow-new-session false

az vm deallocate --ids $(az vm list -g rg-avd-dev --query "[].id" -o tsv)
```

## The Lesson

**Developer experience and cost optimization aren't mutually exclusive.** Good automation makes both possible.

Stop asking people to remember to save money. Build systems that save money automatically while preserving (or improving) developer experience.

---

**Related posts:**
- [Safety Guardrails for Production Systems](/posts/safety-guardrails-production)
- [Observability for Long-Running Deployments](/posts/observability-long-running-deployments)

*Part of a series on lessons learned managing enterprise Azure infrastructure at scale.*
