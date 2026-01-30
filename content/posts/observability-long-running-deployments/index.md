---
title: "Why 'Deployment In Progress' Isn't Good Enough: Building Observability into Long-Running Infrastructure Deployments"
date: 2026-01-20
draft: false
description: "How to add real-time progress tracking to Azure deployments so teams know exactly what's deploying, what's completed, and where failures occurred."
tags: ["Azure", "Observability", "DevOps", "Infrastructure as Code", "Monitoring"]
categories: ["Technical Deep Dive"]
---

## The Problem: Visibility Blackout

You kick off an Azure infrastructure deployment. The terminal shows: `Deployment In Progress...`

And then... nothing. For 2 hours.

Your team asks: "Is it working?" You refresh the Azure Portal. "Still deploying." Stakeholders message: "When will it be done?" You have no idea.

When the deployment finally fails at hour 2, you discover it failed at minute 15—but kept running anyway. **You just wasted 1 hour and 45 minutes debugging the wrong thing.**

This is the reality of enterprise infrastructure deployments without proper observability.

## What's Actually Happening During a Deployment

A typical hub-and-spoke deployment might create:
- 1 Virtual WAN hub (15-20 minutes)
- 1 Azure Firewall Premium (10-15 minutes)
- 2 VPN Gateways (20-30 minutes each)
- 1 ExpressRoute Gateway (20-30 minutes)
- 10+ VNets with peering (2-5 minutes each)
- 50+ network security groups, route tables, policies

That's **80+ individual resource operations** happening in parallel or sequence. "Deployment In Progress" tells you nothing about which operations are active, which completed, and which failed.

## The Solution: Real-Time Deployment Operation Tracking

I enhanced our deployment scripts to provide granular, real-time visibility:

```powershell
function Show-DeploymentProgress {
    param(
        [string]$DeploymentName,
        [string]$Scope = "sub"  # 'sub' for subscription, 'rg' for resource group
    )

    # Get all operations for this deployment
    $operations = az deployment operation $Scope list \
      --name $DeploymentName \
      --query "[].{
          resource: properties.targetResource.resourceName,
          type: properties.targetResource.resourceType,
          state: properties.provisioningState,
          duration: properties.duration,
          timestamp: properties.timestamp
      }" -o json | ConvertFrom-Json

    # Calculate statistics
    $running = ($operations | Where-Object { $_.state -in @("Running", "Accepted") }).Count
    $succeeded = ($operations | Where-Object { $_.state -eq "Succeeded" }).Count
    $failed = ($operations | Where-Object { $_.state -eq "Failed" }).Count
    $total = $operations.Count

    # Show overall status
    Write-Host "`n=== Deployment Progress: $DeploymentName ===" -ForegroundColor Cyan
    Write-Host "Total: $total | Succeeded: $succeeded | Running: $running | Failed: $failed"

    # Show currently deploying resources
    if ($running -gt 0) {
        Write-Host "`nCurrently Deploying:" -ForegroundColor Yellow
        $operations | Where-Object { $_.state -in @("Running", "Accepted") } | ForEach-Object {
            Write-Host "  [⏳] $($_.resource) ($($_.type))"
        }
    }

    # Show failed resources
    if ($failed -gt 0) {
        Write-Host "`nFailed Resources:" -ForegroundColor Red
        $operations | Where-Object { $_.state -eq "Failed" } | ForEach-Object {
            Write-Host "  [❌] $($_.resource) ($($_.type))"
        }
    }

    # Calculate progress percentage
    $progress = if ($total -gt 0) { [math]::Round(($succeeded / $total) * 100, 1) } else { 0 }
    Write-Host "`nProgress: $progress% complete`n"

    return @{
        Total = $total
        Succeeded = $succeeded
        Running = $running
        Failed = $failed
        Progress = $progress
    }
}
```

## How I Use It in CI/CD

Integrated into the deployment polling loop from my [token refresh post](/posts/token-expiration-azure-deployments):

```powershell
# Start deployment
az deployment sub create --name $deploymentName --no-wait

$attempt = 0
$maxAttempts = 240

while ($attempt -lt $maxAttempts) {
    # Refresh token (every 45 minutes)
    # ...

    # Show detailed progress every 30 seconds
    $progress = Show-DeploymentProgress -DeploymentName $deploymentName

    # Check if deployment is complete
    $status = az deployment sub show --name $deploymentName \
      --query "properties.provisioningState" -o tsv

    if ($status -eq "Succeeded") {
        Write-Host "✅ Deployment completed: $($progress.Succeeded) resources deployed" -ForegroundColor Green
        exit 0
    }

    if ($status -eq "Failed") {
        Write-Host "❌ Deployment failed: $($progress.Failed) resources failed" -ForegroundColor Red
        # Detailed error handling...
        exit 1
    }

    Start-Sleep -Seconds 30
    $attempt++
}
```

## What This Gives You

### During Deployment
```
=== Deployment Progress: Deploy_hub_Prod ===
Total: 47 | Succeeded: 32 | Running: 3 | Failed: 0

Currently Deploying:
  [⏳] vng-hub-prod-vpn1 (Microsoft.Network/virtualNetworkGateways)
  [⏳] vng-hub-prod-vpn2 (Microsoft.Network/virtualNetworkGateways)
  [⏳] fw-hub-prod (Microsoft.Network/azureFirewalls)

Progress: 68.1% complete
```

### When Failures Happen
```
=== Deployment Progress: Deploy_gmr_prod ===
Total: 23 | Succeeded: 18 | Running: 0 | Failed: 2

Failed Resources:
  [❌] nsg-gmr-web-prod (Microsoft.Network/networkSecurityGroups)
  [❌] route-gmr-web-prod (Microsoft.Network/routeTables)

Progress: 78.3% complete
```

## The Benefits

**For Engineers:**
- Know exactly which resources are deploying
- Identify failures immediately (not 2 hours later)
- Debug specific resource issues with context

**For Stakeholders:**
- Clear progress updates: "32 of 47 resources deployed (68%)"
- Realistic ETAs based on what's still pending
- Confidence that things are actually working

**For CI/CD:**
- Logs show exactly where deployments stall
- Failed deployments have clear diagnostic info
- Easy to spot patterns (e.g., "VPN Gateway always takes 30 min")

## Advanced: Track Historical Deployment Times

I extended this to build a deployment timing database:

```powershell
# Save deployment metrics
$metrics = @{
    DeploymentName = $deploymentName
    StartTime = $startTime
    EndTime = Get-Date
    Duration = ((Get-Date) - $startTime).TotalMinutes
    ResourceCount = $progress.Total
    Status = $status
}

$metrics | ConvertTo-Json | Out-File "deployment-metrics.json" -Append
```

This data lets you:
- **Predict deployment times**: "Hub deployments average 87 minutes"
- **Optimize bottlenecks**: "VPN Gateways are always the slowest"
- **Track improvements**: "Parallelization reduced time by 35%"

## The Bigger Picture

This experience reinforced a core principle: **In production systems, visibility is as important as functionality.**

Instrumentation isn't something you add later—it should be built in from day one. When deployments take hours and manage critical infrastructure, "Deployment In Progress" isn't good enough.

---

**Previous:** [Solving Token Expiration in Azure Deployments](/posts/token-expiration-azure-deployments)

**Next in series:** [Parameterization: The Art of Infrastructure as Code](/posts/parameterization-infrastructure-code)

*Part of a series on lessons learned managing 1,200+ files of Azure Infrastructure as Code at enterprise scale.*
