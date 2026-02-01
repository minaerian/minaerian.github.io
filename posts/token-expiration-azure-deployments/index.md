---
title: "When Your Azure Deployment Fails at Minute 61: Solving Token Expiration in Long-Running Infrastructure Deployments"
date: 2026-01-15
draft: false
description: "How I solved Azure AD token expiration failures in enterprise infrastructure deployments by implementing asynchronous deployment with proactive token refresh."
tags: ["Azure", "DevOps", "Infrastructure as Code", "Troubleshooting", "Azure AD"]
categories: ["Problem Solving"]
---

## The 61-Minute Failure

Picture this: You've just kicked off an Azure deployment. Your hub infrastructure is rolling out—Azure Firewall, VPN Gateway, ExpressRoute circuits, domain controllers. Everything progresses smoothly for an hour. Then, at minute 61: **AADSTS700024 - Token Expired**.

Your entire deployment fails. Not because of a configuration error. Not because of insufficient permissions. But because Azure AD tokens expire after 60 minutes, and your deployment took 61.

This was my introduction to a critical lesson: **enterprise infrastructure automation isn't just about writing templates—it's about understanding the entire deployment lifecycle.**

## Why This Happens

When you authenticate to Azure using a service principal or user credentials, you receive an access token valid for 60 minutes. For most deployments, this is plenty of time. But enterprise infrastructure deployments—especially hub-and-spoke architectures with firewalls, VPN gateways, and ExpressRoute—routinely take 90+ minutes.

The Azure CLI doesn't automatically refresh tokens during long-running operations. Once that token expires at 60 minutes, any subsequent API calls fail, and your deployment crashes.

## The Failed Approaches

**Attempt 1: "Just run it synchronously"**
```powershell
az deployment sub create --name $deploymentName
# Sits there for 61 minutes, then: token expired
```

**Attempt 2: "Pre-authenticate before deployment"**
```powershell
az login --service-principal ...
az deployment sub create --name $deploymentName --no-wait
# Token still expires while checking status
```

Neither approach solved the fundamental problem: **you need to refresh tokens during multi-hour deployments.**

## The Solution: Asynchronous Deployment with Proactive Token Refresh

I implemented an async deployment strategy with token refresh every 45 minutes:

```powershell
# Start deployment asynchronously (returns immediately)
az deployment sub create \
  --name $deploymentName \
  --template-file hub.bicep \
  --parameters hub.bicepparam \
  --location westus \
  --no-wait

# Track last token refresh time
$lastTokenRefresh = Get-Date
$maxAttempts = 240  # 2 hours max
$attempt = 0

# Poll deployment status with proactive token refresh
while ($attempt -lt $maxAttempts) {
    # Refresh token every 45 minutes (before 60-minute expiration)
    if (((Get-Date) - $lastTokenRefresh).TotalMinutes -ge 45) {
        Write-Host "Refreshing Azure AD token..."
        az login --service-principal \
          -u $env:servicePrincipalId \
          -p $env:servicePrincipalKey \
          --tenant $env:tenantId
        $lastTokenRefresh = Get-Date
    }

    # Check deployment status
    $status = az deployment sub show \
      --name $deploymentName \
      --query "properties.provisioningState" \
      -o tsv

    if ($status -eq "Succeeded") {
        Write-Host "Deployment completed successfully"
        exit 0
    }

    if ($status -eq "Failed") {
        Write-Host "Deployment failed"
        exit 1
    }

    # Wait 30 seconds before next check
    Start-Sleep -Seconds 30
    $attempt++
}
```

## Why This Works

1. **`--no-wait` flag**: Starts deployment asynchronously and returns immediately
2. **45-minute refresh interval**: Refreshes token before the 60-minute expiration
3. **Status polling**: Checks deployment progress every 30 seconds
4. **Graceful exit**: Exits cleanly on success or failure

## Results

Since implementing this pattern:
- ✅ **0 token expiration failures** across 50+ production deployments
- ✅ **Deployments complete reliably** even when taking 2+ hours
- ✅ **Clear failure modes** - deployments fail for real reasons, not auth issues
- ✅ **Works in CI/CD** - Azure DevOps pipelines, GitHub Actions, anywhere

## The Bigger Lesson

This experience taught me that **enterprise automation requires resilience patterns beyond the happy path**:

- Authentication isn't fire-and-forget
- Long-running operations need lifecycle management
- Retry logic and graceful degradation aren't optional
- Observability is critical (more on this in my next post)

If you're building enterprise-scale infrastructure automation, assume long-running operations and build token refresh into your deployment workflows from day one.

---

**Next in this series:** [Observability for Long-Running Deployments](/posts/observability-long-running-deployments) - How to track what's actually happening during 2-hour infrastructure deployments.

**Related:** [Hub-and-Spoke Deployment Orchestration](/posts/hub-spoke-deployment-orchestration)

*This post is part of a series on lessons learned managing 1,200+ files of Azure Infrastructure as Code at enterprise scale.*
