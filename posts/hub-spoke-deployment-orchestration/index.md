---
title: "Hub-and-Spoke at Scale: Why Deployment Order Matters as Much as Your Code"
date: 2026-01-12
draft: false
description: "How to orchestrate Azure hub-and-spoke deployments with explicit dependencies, enabling parallel spoke deployment while ensuring hub resources exist first."
tags: ["Azure", "Architecture", "Hub-and-Spoke", "Azure DevOps", "Networking"]
categories: ["Cloud Architecture"]
---

## The Problem: Spokes Can't Deploy Without a Hub

In a hub-and-spoke architecture, spokes depend on hub resources:
- VNet peering requires the hub VNet to exist
- Routing through hub firewall requires firewall rules
- VPN/ExpressRoute connections terminate at hub gateways
- DNS resolution depends on hub DNS resolver

**If you deploy spokes before the hub:** Deployments fail with "resource not found" errors.

**If you deploy spokes serially after the hub:** Deployments take forever (6 spokes × 45 min each = 4.5 hours).

**The solution:** Orchestrate dependencies explicitly, then parallelize where possible.

## The Architecture

Our hub-and-spoke topology:
- **1 Hub (WestUS):** Virtual WAN, Firewall Premium, VPN Gateways, ExpressRoute, Bastion, DNS
- **6 Spokes:** GMR, IAG, GNT, AZF, VDI, Management (each with dev/prod environments)
- **Cross-region DR:** Disaster recovery hub and spokes in EastUS

**Total:** 2 hubs + 12 spokes = 14 environments to orchestrate

## The Orchestration Strategy

### Stage 1: Deploy Hub First (Sequential)

```yaml
stages:
- stage: Deploy_Hub_Prod
  displayName: 'Deploy Hub - WestUS Prod'
  jobs:
  - deployment: DeployHub
    displayName: 'Deploy Hub Infrastructure'
    environment: 'production'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureCLI@2
            displayName: 'Deploy Hub'
            inputs:
              azureSubscription: 'Azure-Prod-Hub'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                echo "Deploying hub infrastructure..."

                az deployment sub create \
                  --name Deploy_hub_Prod \
                  --location westus \
                  --template-file ./definitions/hub.bicep \
                  --parameters ./parameters/hub-prod.bicepparam

                echo "✅ Hub deployment complete"
```

**Wait for hub to complete before continuing.**

### Stage 2: Deploy All Spokes in Parallel

```yaml
- stage: Deploy_Spokes_Prod
  displayName: 'Deploy Spokes - Prod'
  dependsOn: Deploy_Hub_Prod  # Hub must complete first
  jobs:
  - deployment: Deploy_GMR_Prod
    displayName: 'Deploy GMR Spoke'
    environment: 'production'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureCLI@2
            displayName: 'Deploy GMR'
            inputs:
              azureSubscription: 'Azure-Prod-Spokes'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az deployment sub create \
                  --name Deploy_gmr_prod \
                  --location westus \
                  --template-file ./definitions/spoke.bicep \
                  --parameters ./parameters/gmr-prod.bicepparam

  - deployment: Deploy_IAG_Prod
    displayName: 'Deploy IAG Spoke'
    environment: 'production'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureCLI@2
            displayName: 'Deploy IAG'
            inputs:
              azureSubscription: 'Azure-Prod-Spokes'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az deployment sub create \
                  --name Deploy_iag_prod \
                  --location westus \
                  --template-file ./definitions/spoke.bicep \
                  --parameters ./parameters/iag-prod.bicepparam

  # Repeat for GNT, AZF, VDI, Management spokes...
  # All run in parallel since they don't depend on each other
```

**Key insight:** `dependsOn: Deploy_Hub_Prod` ensures hub completes first, then all spokes deploy in parallel.

## Visualizing Dependencies

```
┌─────────────────────┐
│   Deploy Hub Prod   │  Stage 1: Sequential (45-90 min)
└──────────┬──────────┘
           │
           │ dependsOn
           │
     ┌─────┴─────────────────────────────┐
     │                                   │
┌────▼────┐  ┌────────┐  ┌────────┐  ┌────────┐
│   GMR   │  │  IAG   │  │  GNT   │  │  AZF   │
│  Spoke  │  │ Spoke  │  │ Spoke  │  │ Spoke  │
└─────────┘  └────────┘  └────────┘  └────────┘
     │
     │ Stage 2: Parallel (45 min total, not 45×6)
     └───────────────────────────────────────┘
```

**Result:** 6 spokes deploy in **45 minutes** (parallelized), not 4.5 hours (sequential).

## The Results

**Before orchestration (sequential):**
- Hub: 90 minutes
- 6 Spokes (serial): 6 × 45 min = 270 minutes
- **Total: 6 hours**

**After orchestration (parallel):**
- Hub: 90 minutes
- 6 Spokes (parallel): 45 minutes
- **Total: 135 minutes (2.25 hours)**

**Improvement: 63% faster deployments**

## Handling Cross-Spoke Dependencies

**Problem:** Sometimes spokes depend on other spokes (e.g., VDI spoke needs identity spoke's DNS settings).

**Solution:** Add explicit dependencies:

```yaml
- deployment: Deploy_VDI_Prod
  displayName: 'Deploy VDI Spoke'
  dependsOn:
    - Deploy_Hub_Prod         # Needs hub
    - Deploy_Identity_Prod    # Needs identity spoke's DNS
  environment: 'production'
```

Now VDI waits for both hub and identity, but other spokes still deploy in parallel.

## For Multi-Region (DR)

```yaml
stages:
# Primary Region (WestUS)
- stage: Deploy_Hub_WestUS
  displayName: 'Deploy Hub - WestUS'

- stage: Deploy_Spokes_WestUS
  dependsOn: Deploy_Hub_WestUS

# DR Region (EastUS) - can run in parallel with WestUS spokes
- stage: Deploy_Hub_EastUS
  dependsOn: Deploy_Hub_WestUS  # Wait for primary hub
  displayName: 'Deploy DR Hub - EastUS'

- stage: Deploy_Spokes_EastUS
  dependsOn: Deploy_Hub_EastUS
  displayName: 'Deploy DR Spokes - EastUS'
```

**Primary and DR can progress independently** (except initial hub dependency).

## The Lesson

**Infrastructure dependencies are as critical as code dependencies.**

- Treat deployment order as rigorously as you treat application dependency graphs
- Make dependencies explicit (not implicit or assumed)
- Parallelize aggressively where dependencies allow
- Test dependency orchestration in dev before promoting to prod

If you're deploying hub-and-spoke architectures sequentially, you're leaving performance on the table. Orchestrate explicitly, then parallelize.

---

**Related posts:**
- [Token Expiration in Azure Deployments](/posts/token-expiration-azure-deployments)
- [Observability for Long-Running Deployments](/posts/observability-long-running-deployments)
- [Parameterization in Infrastructure as Code](/posts/parameterization-infrastructure-code)

*Part of a series on lessons learned managing 1,200+ files of Azure Infrastructure as Code at enterprise scale.*
