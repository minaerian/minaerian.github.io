---
title: "I Ran a Cleanup Script Against Production Once. Here's How I Made Sure It Never Happens Again."
date: 2026-01-22
draft: false
description: "Production-grade safety guardrails that prevent 2 AM incidents by failing safely instead of catastrophically."
tags: ["DevOps", "Safety", "Production", "Azure", "Best Practices"]
categories: ["Operational Excellence"]
---

## The Incident

Early in the project, I was testing a cleanup script against the dev environment. Or so I thought.

I ran the script. Within 30 seconds, I realized my terminal was connected to the **production subscription**.

I'd just deleted critical network security groups from production.

**That happened once. Never again.**

## The Problem: Humans Make Mistakes

You can be careful. You can be experienced. You can double-check. **You will still make mistakes.**

The question isn't "Will I make a mistake?" It's "When I make a mistake, what breaks?"

## The Solution: Multiple Safety Layers

Every operational script now includes multiple independent safety checks. If any check fails, the script exits before touching anything.

### Layer 1: Subscription ID Allowlist

```powershell
# cleanup-dev-resources.ps1

param(
    [Parameter(Mandatory=$false)]
    [switch]$Apply  # Dry-run by default
)

# Explicitly allowed subscriptions
$allowedSubscriptionIds = @(
    '10d75c52-6c31-4c96-af43-ca0806e178bc',  # Platform-Dev-Hub
    'b099030c-42de-41ce-be79-4de77761255a'   # Platform-Sub-Dev-Spokes
)

# Get current subscription
$currentSubscription = az account show | ConvertFrom-Json
$subscriptionId = $currentSubscription.id
$subscriptionName = $currentSubscription.name

# Check 1: Subscription ID
if ($subscriptionId -notin $allowedSubscriptionIds) {
    Write-Error "❌ SAFETY CHECK FAILED: Subscription not in allowed list"
    Write-Error "Current subscription: $subscriptionName ($subscriptionId)"
    Write-Error "Allowed subscriptions:"
    $allowedSubscriptionIds | ForEach-Object { Write-Error "  - $_" }
    exit 1
}

Write-Host "✅ Subscription ID check passed: $subscriptionName"
```

### Layer 2: Subscription Name Validation

```powershell
# Check 2: Subscription name (redundant check)
$expectedNames = @('Platform-Dev-Hub', 'Platform-Sub-Dev-Spokes')

if ($subscriptionName -notin $expectedNames) {
    Write-Error "❌ SAFETY CHECK FAILED: Subscription name mismatch"
    Write-Error "Current: $subscriptionName"
    Write-Error "Expected one of: $($expectedNames -join ', ')"
    exit 1
}

Write-Host "✅ Subscription name check passed"
```

### Layer 3: Environment Tag Validation

```powershell
# Check 3: Verify environment tag on resource groups
$resourceGroups = az group list | ConvertFrom-Json

foreach ($rg in $resourceGroups) {
    $envTag = $rg.tags.environment

    if ($envTag -eq 'production' -or $envTag -eq 'prod') {
        Write-Error "❌ SAFETY CHECK FAILED: Production environment detected"
        Write-Error "Resource group $($rg.name) has environment tag: $envTag"
        exit 1
    }
}

Write-Host "✅ Environment tag check passed"
```

### Layer 4: Explicit Confirmation Required

```powershell
# Check 4: Dry-run by default, explicit --Apply required
if (-not $Apply) {
    Write-Host "`n⚠️  DRY-RUN MODE (no changes will be made)" -ForegroundColor Yellow
    Write-Host "Resources that would be deleted:"

    # Show what would be deleted
    az resource list --query "[?resourceGroup=='rg-hub-dev'].{name:name, type:type}" -o table

    Write-Host "`nTo actually delete these resources, run with -Apply flag"
    exit 0
}

Write-Host "`n⚠️  APPLY MODE - Resources will be deleted!" -ForegroundColor Red
Start-Sleep -Seconds 3  # Give time to Cancel
```

## In CI/CD Pipelines

For Azure DevOps pipelines, add environment protection:

```yaml
jobs:
- deployment: CleanupDevEnvironment
  displayName: 'Cleanup Dev Resources'
  environment: 'dev-cleanup'  # Requires approval if misconfigured
  variables:
    allowedSubscription: '10d75c52-6c31-4c96-af43-ca0806e178bc'

  strategy:
    runOnce:
      deploy:
        steps:
        - task: AzureCLI@2
          displayName: 'Validate Subscription'
          inputs:
            azureSubscription: 'Platform-Dev-ServiceConnection'
            scriptType: 'bash'
            scriptLocation: 'inlineScript'
            inlineScript: |
              CURRENT_SUB=$(az account show --query id -o tsv)

              if [ "$CURRENT_SUB" != "$(allowedSubscription)" ]; then
                echo "❌ Subscription mismatch!"
                echo "Current: $CURRENT_SUB"
                echo "Expected: $(allowedSubscription)"
                exit 1
              fi

              echo "✅ Subscription validated"

        - task: AzureCLI@2
          displayName: 'Cleanup Resources'
          inputs:
            azureSubscription: 'Platform-Dev-ServiceConnection'
            scriptType: 'bash'
            scriptLocation: 'scriptPath'
            scriptPath: 'scripts/cleanup-dev.sh'
```

## Resource Locks for Production

**On production resources, add locks:**

```bash
# Lock production resource groups to prevent deletion
az lock create \
  --name 'prevent-deletion' \
  --lock-type CanNotDelete \
  --resource-group rg-hub-prod

# Lock critical resources individually
az lock create \
  --name 'prevent-deletion' \
  --lock-type CanNotDelete \
  --resource-group rg-hub-prod \
  --resource-name fw-hub-prod \
  --resource-type Microsoft.Network/azureFirewalls
```

Even if you run a delete script against production with locks in place, **Azure will reject the deletion**.

## The Results

**Since implementing these guardrails:**
- ✅ 0 accidental production changes
- ✅ 0 wrong-subscription incidents
- ✅ Scripts fail safely and loudly before touching anything
- ✅ Dry-run mode catches mistakes before they happen

**The overhead:**
- 5-10 lines of validation code per script
- 3 seconds of validation time
- Zero cognitive load (automated checks)

## The Lesson

**Production systems require production-grade safety. Assume mistakes will happen, and build systems that fail safely.**

Good guardrails:
- Are automated (not reliant on human vigilance)
- Have multiple independent checks (defense in depth)
- Fail loudly and early (before any changes)
- Require explicit intent for destructive actions (dry-run by default)

Don't rely on being careful. Rely on systems that make it hard to break things.

---

**Related posts:**
- [Cost Optimization Through Automation](/posts/cost-optimization-automation)
- [What-If Analysis for Infrastructure Changes](/posts/whatif-analysis-azure)

*Part of a series on lessons learned managing enterprise Azure infrastructure at scale.*
