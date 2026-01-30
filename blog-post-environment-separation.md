# Environment Separation in Azure IaC: The Deployment Scope Strategy

## Introduction: One Template, Four Environments

You've written your Azure infrastructure templates. They work perfectly in development. Then you deploy to production using the same templates, and everything blows up.

Why? Because you hardcoded subscription IDs. Or IP ranges overlap. Or you accidentally deployed dev resources into production subscriptions. Or production locked down network security while dev needs wide-open access for testing.

**The problem isn't the templates—it's the lack of proper environment separation.**

After managing Azure infrastructure across 4 environments (dev, prod, drdev, drprod) with hub-and-spoke architecture spanning multiple subscriptions, I've learned that **environment separation isn't just about parameter files—it's about architecting deployment scopes that enforce isolation at every level**.

This post explains the deployment scope strategy that makes it impossible to accidentally deploy dev resources into production, overlap IP ranges, or violate security boundaries between environments.

---

## The Problem: Shared Templates, Isolated Environments

### The Challenge

You need to deploy the same infrastructure pattern across multiple environments:

- **Development**: Rapid iteration, cost optimization, relaxed security
- **QA/Staging**: Production-like testing with isolated data
- **Production**: High availability, security hardening, compliance
- **Disaster Recovery**: Separate region, separate subscriptions, production-grade resilience

**Requirements:**
- Same templates across all environments (DRY principle)
- Complete isolation between environments (no cross-contamination)
- Different configurations per environment (IP ranges, SKUs, feature flags)
- Safe deployments (impossible to accidentally deploy to wrong environment)

**Traditional approach:** Copy-paste templates for each environment, leading to drift and maintenance nightmares.

**Better approach:** Single source of truth with environment-specific deployment scopes.

---

## The Solution: Deployment Scope Architecture

### Subscription-Scoped Deployments

Every infrastructure definition uses subscription scope:

```bicep
// definitions/hub.bicep
targetScope = 'subscription'

// Deploy resources across subscription
module network_rg 'br/public:avm/res/resources/resource-group:0.4.0' = {
  name: '${network_rg_config.name}-${uniqueString(deployment().name)}'
  scope: subscription(network_rg_config.targetSubscriptionId)
  params: {
    name: network_rg_config.name
    location: location
    tags: network_rg_config.tags
  }
}
```

**Why subscription scope?**

1. **Cross-subscription deployments**: Hub in one subscription, spokes in others
2. **Environment isolation**: Each environment targets different subscription IDs
3. **Resource organization**: Create resource groups as part of deployment
4. **Governance**: Subscription-level RBAC prevents cross-environment access

---

## The Deployment Scopes Pattern

### Environment Configuration Object

The heart of the strategy is the `deployment_scopes` configuration object in parameter files:

```bicep
// parameters/hub.bicepparam
var deployment_scopes = {
  dev: {
    hubSubscriptionId: '10d75c52-6c31-4c96-af43-ca0806e178bc' // Platform-Dev-Hub
    vhub_addressSpace: '10.90.0.0/24'
    ss_vnet_prefix: '10.91'
    p2s_addressSpace: '172.16.172.0/22'
    existingVwanResourceId: ''
    existingFwPolicyResourceId: ''
  }
  prod: {
    hubSubscriptionId: '8bce6638-f25f-496b-ba88-5ef61ce47b90' // Platform-Sub-Prod
    vhub_addressSpace: '10.10.0.0/24'
    ss_vnet_prefix: '10.10'
    p2s_addressSpace: '172.16.172.0/22'
    existingVwanResourceId: ''
    existingFwPolicyResourceId: ''
  }
  drdev: {
    hubSubscriptionId: '10d75c52-6c31-4c96-af43-ca0806e178bc' // DR-Platform-Dev-Hub
    vhub_addressSpace: '10.190.0.0/24'
    ss_vnet_prefix: '10.191'
    p2s_addressSpace: '172.16.180.0/22'
    existingVwanResourceId: '/subscriptions/.../platform-vwan-dev-wus'
    existingFwPolicyResourceId: ''
  }
  drprod: {
    hubSubscriptionId: 'df6cd7ed-01e9-4211-b9fc-0875c87e79f7' // DR-Platform-Sub-Prod
    vhub_addressSpace: '10.110.0.0/24'
    ss_vnet_prefix: '10.110'
    p2s_addressSpace: '172.16.180.0/22'
    existingVwanResourceId: '/subscriptions/.../platform-vwan-prod-wus'
    existingFwPolicyResourceId: ''
  }
}

// Select current environment based on runtime variable
var iac_env = readEnvironmentVariable('iac_env', 'dev')
var currentEnvironment = deployment_scopes[toLower(iac_env)]

// Extract environment-specific values
var hub_subscriptionId = currentEnvironment.hubSubscriptionId
var vhub_addressSpace = currentEnvironment.vhub_addressSpace
var ss_vnet_prefix = currentEnvironment.ss_vnet_prefix
var p2s_addressSpace = currentEnvironment.p2s_addressSpace
```

### How It Works

**1. Runtime Environment Selection**

Environment is determined by the `iac_env` environment variable:

```powershell
# Local deployment
$env:iac_env = "dev"
az deployment sub create --location WestUS --template-file hub.bicep --parameters hub.bicepparam

# Pipeline deployment (Azure DevOps)
env:
  iac_env: $(iac_env)  # Set in pipeline variables
```

**2. Scope Lookup**

The parameter file looks up the environment configuration:

```bicep
var currentEnvironment = deployment_scopes[toLower(iac_env)]
```

If `iac_env = "prod"`, then `currentEnvironment` becomes:
```bicep
{
  hubSubscriptionId: '8bce6638-f25f-496b-ba88-5ef61ce47b90'
  vhub_addressSpace: '10.10.0.0/24'
  // ...
}
```

**3. Scope Application**

Every module deployment uses the environment-specific subscription ID:

```bicep
module network_rg 'br/public:avm/res/resources/resource-group:0.4.0' = {
  scope: subscription(hub_subscriptionId)  // ← Environment-specific subscription
  params: {
    name: '${scope_prefix}-network-rg-${toLower(iac_env)}-${location}'
    // ...
  }
}
```

---

## Benefits of Deployment Scope Strategy

### 1. Impossible to Deploy to Wrong Environment

**Scenario:** Developer accidentally runs prod deployment locally.

**Protection:**
```powershell
$env:iac_env = "prod"
az deployment sub create --location WestUS --template-file hub.bicep --parameters hub.bicepparam
```

**Result:** Deployment targets `hubSubscriptionId: '8bce6638-f25f-496b-ba88-5ef61ce47b90'`

If the developer doesn't have access to the production subscription, the deployment fails immediately with permission denied. The templates themselves enforce the isolation.

**Without this pattern:** Developer could accidentally deploy to production subscription if they have credentials.

### 2. Guaranteed IP Range Isolation

**Problem:** Overlapping IP ranges break hub-and-spoke networking.

**Solution:** Environment-specific address spaces:

| Environment | Virtual Hub | Shared Services VNet | P2S VPN | Region |
|-------------|-------------|----------------------|---------|--------|
| **dev** | 10.90.0.0/24 | 10.91.x.x/20 | 172.16.172.0/22 | WestUS |
| **prod** | 10.10.0.0/24 | 10.10.x.x/20 | 172.16.172.0/22 | WestUS |
| **drdev** | 10.190.0.0/24 | 10.191.x.x/20 | 172.16.180.0/22 | EastUS |
| **drprod** | 10.110.0.0/24 | 10.110.x.x/20 | 172.16.180.0/22 | EastUS |

These ranges are **computed from the environment scope**, not manually maintained in multiple places:

```bicep
param vhub_config = {
  name: '${scope_prefix}-vhub-${toLower(iac_env)}-${location}'
  addressPrefix: vhub_addressSpace  // ← From deployment_scopes lookup
  // ...
}
```

**Result:** IP ranges cannot overlap because they're centrally defined in the `deployment_scopes` object.

### 3. Environment-Specific Feature Flags

Different environments need different features:

**Dev:**
- Basic SKUs (cost optimization)
- Relaxed firewall rules (developer access)
- No resource locks (frequent teardown/rebuild)
- Simplified topology

**Production:**
- Premium SKUs (performance, SLA)
- Strict firewall rules (compliance)
- CanNotDelete locks (prevent accidental deletion)
- Full topology with ExpressRoute, redundant gateways

**Implementation:**

```bicep
// Conditional resource deployment based on environment
resource expressRouteGateway 'Microsoft.Network/expressRouteGateways@2024-01-01' = if (iac_env == 'prod' || iac_env == 'drprod') {
  name: '${scope_prefix}-er-gateway-${toLower(iac_env)}-${location}'
  location: location
  properties: {
    virtualHub: {
      id: vhub.outputs.resourceId
    }
  }
}

// Environment-specific SKUs
var firewallSku = iac_env == 'prod' ? 'Premium' : 'Standard'

// Environment-specific locks
var resourceLock = (iac_env == 'prod' || iac_env == 'drprod') ? {
  name: 'CanNotDelete'
  kind: 'CanNotDelete'
} : null
```

### 4. Pipeline Integration with Branch Protection

Azure DevOps pipeline configuration enforces environment separation:

```yaml
# pipelines/deploy-dr.yml
variables:
- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:
  - group: azure-iac-prod
  - name: iac_env
    value: drprod
- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/dev') }}:
  - group: azure-iac-dev
  - name: iac_env
    value: drdev
```

**Branch-based environment mapping:**

| Git Branch | Environment | Subscription | Approval Required |
|------------|-------------|--------------|-------------------|
| `dev` | drdev | Platform-Dev-Hub | No |
| `main` | drprod | DR-Platform-Sub-Prod | Yes (environment gate) |

**Protection mechanisms:**
1. Dev branch cannot deploy to production (branch condition)
2. Main branch requires manual approval (environment gate)
3. Different variable groups per environment (credentials isolated)
4. Separate deployment stages enforce ordering

### 5. Multi-Subscription Architecture

The deployment scope pattern enables complex subscription topologies:

```
Production Environment:
├── Platform-Sub-Prod (Hub subscription)
│   ├── Virtual WAN
│   ├── Virtual Hub
│   ├── Azure Firewall
│   ├── VPN Gateways
│   └── Shared Services VNet
│
├── Platform-Prod-Spokes (Spoke subscription)
│   ├── GMR Spoke Network
│   ├── IAG Spoke Network
│   ├── GNT Spoke Network
│   └── AZF Spoke Network
│
├── GMR-Prod-Sub (GMR workload subscription)
│   └── GMR application resources
│
├── IAG-Prod-Sub (IAG workload subscription)
│   └── IAG application resources
│
└── GNT-Prod-Sub (GNT workload subscription)
    └── GNT application resources
```

**Each spoke references its own subscription:**

```bicep
// parameters/gmr.bicepparam
var deployment_scopes = {
  dev: {
    networkSubscriptionId: 'b099030c-42de-41ce-be79-4de77761255a'  // Platform-Dev-Spokes
    workloadSubscriptionId: 'b099030c-42de-41ce-be79-4de77761255a' // Same for dev
  }
  prod: {
    networkSubscriptionId: '4b8e9c12-3a4d-4e5f-a678-9b0c1d2e3f4a'  // Platform-Prod-Spokes
    workloadSubscriptionId: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d' // GMR-Prod-Sub
  }
}
```

**Benefits:**
- **Billing isolation**: Each workload has separate Azure billing
- **Security isolation**: Separate RBAC, policies, security boundaries
- **Blast radius containment**: Issues in one workload don't affect others
- **Compliance**: Separate subscriptions for regulated workloads

---

## Implementation Patterns

### Pattern 1: Shared Parameter File, Environment Variable Selection

**Single parameter file** ([parameters/hub.bicepparam](parameters/hub.bicepparam)) serves all environments.

**Advantages:**
- Single source of truth
- Environment-specific values centralized in one place
- Easier to compare environments (all in one file)
- Fewer files to maintain

**Trade-offs:**
- Parameter file can become large (2,400+ lines for complex hub)
- All environments visible in one file (could be a pro or con)

### Pattern 2: Resource Naming with Environment Suffix

All resources include environment identifier:

```bicep
var resourceName = '${scope_prefix}-${resource_type}-${toLower(iac_env)}-${location}'

// Examples:
// platform-vhub-dev-wus
// platform-vhub-prod-wus
// platform-vhub-drdev-eus
// platform-vhub-drprod-eus
```

**Benefits:**
- Resources self-document their environment
- Easy to identify environment in Azure Portal
- Prevents naming conflicts across environments
- Enables resource group regex matching for cleanup scripts

### Pattern 3: Existing Resource References for DR

Disaster recovery environments reference primary region resources:

```bicep
drdev: {
  existingVwanResourceId: '/subscriptions/.../platform-vwan-dev-wus'
  existingFwPolicyResourceId: ''
}
drprod: {
  existingVwanResourceId: '/subscriptions/.../platform-vwan-prod-wus'
  existingFwPolicyResourceId: ''
}
```

**Why?**
- Virtual WAN spans regions (one vWAN, multiple regional hubs)
- Firewall policies can be shared across regions
- DR environments extend primary, don't duplicate everything

**Dev/Prod environments:**
```bicep
dev: {
  existingVwanResourceId: ''  // Create new
  existingFwPolicyResourceId: ''  // Create new
}
```

### Pattern 4: Conditional Deployment Based on Region and Branch

Some resources only deploy in primary region or specific branches:

```bicep
// Domain controllers only in primary region (WestUS)
resource domainController1 'Microsoft.Compute/virtualMachines@2024-03-01' = if (region == 'WestUS') {
  name: 'dc1-${toLower(iac_env)}'
  // ...
}

// ExpressRoute only in production
resource expressRouteGateway '...' = if (source_branch == 'prod' || source_branch == 'drprod') {
  // ...
}

// Locks only in production branches
var resourceLock = (source_branch == 'prod' || source_branch == 'drprod') ? {
  kind: 'CanNotDelete'
} : null
```

---

## Real-World Example: Hub Deployment

### Local Deployment (Development)

```powershell
# Set environment
$env:iac_env = "dev"
$env:resource_env = "dev"
$env:location = "WestUS"
$env:location_suffix = "wus"
$env:DC1_ADMIN_PASSWORD = "SecureP@ssw0rd123!"
$env:DC2_ADMIN_PASSWORD = "SecureP@ssw0rd456!"

# Deploy
az deployment sub create `
  --location WestUS `
  --template-file definitions/hub.bicep `
  --parameters parameters/hub.bicepparam
```

**What happens:**
1. Parameter file reads `iac_env = "dev"` from environment variable
2. Looks up `deployment_scopes['dev']`:
   - `hubSubscriptionId: '10d75c52-...'` (Platform-Dev-Hub)
   - `vhub_addressSpace: '10.90.0.0/24'`
   - `ss_vnet_prefix: '10.91'`
3. Deploys to dev subscription with dev IP ranges
4. Creates resources named `platform-*-dev-wus`
5. No resource locks applied (dev environment)
6. Basic SKUs for cost optimization

### Pipeline Deployment (Production)

```yaml
# pipelines/deploy-dr.yml (main branch)
variables:
  - name: iac_env
    value: drprod
  - name: location
    value: EastUS

stages:
- stage: Deploy_Prod
  condition: eq(variables['Build.SourceBranch'], 'refs/heads/main')
  jobs:
  - deployment: Deploy_hub_Prod
    environment: prod  # ← Requires manual approval
    steps:
    - task: AzureCLI@2
      inputs:
        azureSubscription: 'azure-iac-secret'
        inlineScript: |
          az deployment sub create \
            --name "iac-drprod-$(Build.BuildId)" \
            --location "EastUS" \
            --template-file "./definitions/hub.bicep" \
            --parameters "./parameters/hub.bicepparam"
      env:
        iac_env: drprod
        location: EastUS
        location_suffix: eus
```

**What happens:**
1. Pipeline requires manual approval (environment: prod)
2. Uses `azure-iac-prod` variable group (production credentials)
3. Parameter file reads `iac_env = "drprod"`
4. Looks up `deployment_scopes['drprod']`:
   - `hubSubscriptionId: 'df6cd7ed-...'` (DR-Platform-Sub-Prod)
   - `vhub_addressSpace: '10.110.0.0/24'`
   - References existing vWAN from primary region
5. Deploys to DR prod subscription with DR IP ranges
6. Creates resources named `platform-*-drprod-eus`
7. Applies CanNotDelete locks (production)
8. Premium SKUs for production SLA

**Impossible to deploy to wrong environment:**
- Dev branch can't trigger prod deployment (branch condition)
- Prod requires approval gate (manual verification)
- Different service connections per environment (credential isolation)
- Subscription IDs hardcoded in deployment_scopes (fail if wrong sub)

---

## Why This Approach Follows Best Practices

### 1. Infrastructure as Code Best Practices

✅ **Single source of truth**: One template serves all environments
✅ **DRY principle**: No duplicated templates
✅ **Declarative**: Desired state, not imperative scripts
✅ **Version controlled**: All configuration in Git
✅ **Testable**: Can validate against all environments

### 2. Azure Well-Architected Framework

✅ **Reliability**: Environment isolation prevents cascading failures
✅ **Security**: Subscription boundaries enforce RBAC isolation
✅ **Cost Optimization**: Environment-specific SKUs optimize spend
✅ **Operational Excellence**: Consistent deployment patterns
✅ **Performance Efficiency**: Premium SKUs where needed, basic elsewhere

### 3. Cloud Adoption Framework

✅ **Environment strategy**: Clear dev/test/prod separation
✅ **Subscription design**: Purpose-driven subscription boundaries
✅ **Resource organization**: Consistent naming, tagging
✅ **Governance**: Policy, RBAC, locks at subscription level
✅ **Platform automation**: IaC with environment-specific deployment

### 4. DevOps Best Practices

✅ **Shift left**: Validate environments early in pipeline
✅ **Fail fast**: Deployment fails immediately if wrong subscription
✅ **Environment parity**: Same templates guarantee consistency
✅ **Approval gates**: Production deployments require manual approval
✅ **Traceability**: Git commit → build ID → deployment name

---

## Common Pitfalls and How This Pattern Avoids Them

### Pitfall 1: Hardcoded Values

❌ **Anti-pattern:**
```bicep
param subscriptionId string = '8bce6638-f25f-496b-ba88-5ef61ce47b90'  // Hardcoded
```

✅ **This pattern:**
```bicep
var subscriptionId = deployment_scopes[iac_env].hubSubscriptionId  // Environment-aware
```

### Pitfall 2: Copy-Paste Templates

❌ **Anti-pattern:**
```
templates/
├── hub-dev.bicep
├── hub-prod.bicep
└── hub-dr.bicep  # Drift over time
```

✅ **This pattern:**
```
definitions/
└── hub.bicep  # Single source of truth
```

### Pitfall 3: Manual IP Range Management

❌ **Anti-pattern:**
```bicep
// hub-dev.bicep
param vnetAddressSpace string = '10.90.0.0/24'

// hub-prod.bicep
param vnetAddressSpace string = '10.10.0.0/24'  // Manually kept in sync
```

✅ **This pattern:**
```bicep
var deployment_scopes = {
  dev: { vnet_prefix: '10.90' }
  prod: { vnet_prefix: '10.10' }
}
var vnetAddressSpace = '${currentEnvironment.vnet_prefix}.0.0/24'
```

### Pitfall 4: Inconsistent Naming

❌ **Anti-pattern:**
```
platform-vhub-dev
platform-hub-prod  // Missing "v", inconsistent
platform-drprod-vhub  // Order wrong
```

✅ **This pattern:**
```bicep
var name = '${scope_prefix}-${resource_type}-${toLower(iac_env)}-${location}'
// Always: platform-vhub-{env}-{loc}
```

### Pitfall 5: No Deployment Safeguards

❌ **Anti-pattern:**
```powershell
az deployment sub create --template-file hub-prod.bicep
# Could accidentally run in wrong subscription
```

✅ **This pattern:**
```bicep
scope: subscription(hub_subscriptionId)  // Explicit subscription targeting
# Fails immediately if don't have access to target subscription
```

---

## Extending the Pattern

### Adding a New Environment

**Scenario:** Need to add a QA environment in Central US.

**Steps:**

1. **Update deployment_scopes** in parameter file:
```bicep
var deployment_scopes = {
  // ... existing environments
  qa: {
    hubSubscriptionId: 'new-qa-subscription-id'
    vhub_addressSpace: '10.200.0.0/24'  // New IP range
    ss_vnet_prefix: '10.201'
    p2s_addressSpace: '172.16.200.0/22'
    existingVwanResourceId: ''
    existingFwPolicyResourceId: ''
  }
}
```

2. **Update pipeline** (if needed):
```yaml
variables:
- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/qa') }}:
  - name: iac_env
    value: qa
  - name: location
    value: CentralUS
```

3. **Deploy:**
```powershell
$env:iac_env = "qa"
$env:location = "CentralUS"
az deployment sub create --location CentralUS --template-file hub.bicep --parameters hub.bicepparam
```

**Result:** New environment deployed with no template changes. IP ranges guaranteed not to conflict.

### Adding Environment-Specific Configuration

**Scenario:** Production needs Azure DDoS Protection, dev doesn't.

**Implementation:**

```bicep
var deployment_scopes = {
  dev: {
    enableDDoSProtection: false
    ddosProtectionPlanId: ''
  }
  prod: {
    enableDDoSProtection: true
    ddosProtectionPlanId: '/subscriptions/.../providers/Microsoft.Network/ddosProtectionPlans/prod-ddos'
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  properties: {
    enableDdosProtection: currentEnvironment.enableDDoSProtection
    ddosProtectionPlan: currentEnvironment.enableDDoSProtection ? {
      id: currentEnvironment.ddosProtectionPlanId
    } : null
  }
}
```

---

## Conclusion: Deployment Scopes as Architectural Foundation

The deployment scope strategy isn't just a templating technique—it's an **architectural pattern that enforces environment isolation at the infrastructure layer**.

**Key Principles:**

1. **Environment selection at runtime**, not compile time
2. **Subscription boundaries as security boundaries**
3. **Centralized configuration** in deployment_scopes object
4. **Computed resource properties** from environment lookup
5. **Pipeline enforcement** with branch protection and approval gates

**What makes this production-grade:**

✅ Cannot accidentally deploy to wrong environment (subscription check fails)
✅ Cannot overlap IP ranges (centrally defined per environment)
✅ Cannot skip production approval (environment gate required)
✅ Cannot use wrong credentials (separate variable groups)
✅ Cannot create naming conflicts (environment suffix in all names)

**The difference between hobbyist and enterprise IaC:**

- **Hobbyist:** Copy templates, manually update values, hope for the best
- **Enterprise:** Single template, environment-specific scopes, impossible to make mistakes

When someone asks "How do you manage multiple environments in Azure?", the answer isn't parameter files or variable substitution—it's **deployment scope architecture** that makes wrong deployments structurally impossible.

If your organization is struggling with environment drift, accidental production deployments, or IP range conflicts, this pattern provides a foundation for **safe, scalable, multi-environment infrastructure as code**.

---

**Technologies:** Azure Bicep, Azure Resource Manager, Azure DevOps, Subscription-scoped deployments

**Skills Demonstrated:** Multi-environment architecture, Subscription management, Environment isolation, Pipeline orchestration, IaC best practices

**Repository:** [Available upon request]

---

*Part of a series on building enterprise-scale Azure infrastructure. See also: [Technical Deep Dive: IaC Patterns](blog-post-technical-deep-dive.md)*

*Written January 2026 after managing multi-environment Azure platform across 4 environments and multiple subscriptions*
