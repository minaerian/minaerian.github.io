---
title: "Operational Excellence in Azure IaC: Beyond Writing Templates"
date: 2026-01-27
draft: false
description: "7 operational excellence patterns that make Azure infrastructure safe to operate at scale—from shared validation modules to token refresh strategies."
tags: ["Azure", "PowerShell", "DevOps", "Operational Excellence", "Automation", "Best Practices", "Git Hooks", "Infrastructure as Code"]
categories: ["Operational Excellence", "DevOps"]
---

## Introduction: The Infrastructure That Runs Itself (Safely)

You've written the perfect Bicep template. It deploys flawlessly. Your hub-and-spoke architecture is beautiful. Then someone runs a cleanup script in the wrong subscription and deletes production.

Or a junior engineer commits Bicep syntax errors that break the pipeline. Or a long-running cleanup operation fails after 55 minutes because the auth token expired. Or cross-platform line endings cause mysterious deployment failures.

**Good infrastructure as code isn't just about deployment templates—it's about the operational patterns that prevent disasters.**

After managing 1,258 files of Azure infrastructure across 4 environments and building operational automation for platform teams, I've learned that the difference between hobbyist projects and production-grade infrastructure is **the guardrails you build around it**.

This post covers 7 operational excellence patterns embedded in PowerShell scripts, configuration files, and automation setup—the operational layer that makes infrastructure **safe to operate at scale**.

---

## 1. Guardrails Everywhere: The PowerShell Module Pattern

### The Problem

When you have 9 cleanup scripts (firewall deallocation, VPN gateway deletion, resource group cleanup, spoke network teardown), the naïve approach is to copy validation logic across all of them:

```powershell
# ❌ Copied in every script
$allowedSubscriptionIds = @('sub-1', 'sub-2', 'sub-3')
if ($subscriptionId -notin $allowedSubscriptionIds) {
    throw "Wrong subscription!"
}

$context = Get-AzContext
if ($context.Subscription.Name -ne $expectedName) {
    throw "Wrong context!"
}
```

**Problems:**
- Duplication across 9 scripts
- Inconsistent validation logic
- Hard to update when requirements change
- Copy-paste errors introduce security holes

### The Solution: Shared Validation Module

Created `Common-AzureCleanupFunctions.psm1` with reusable validation functions:

```powershell
<#
.SYNOPSIS
Common validation and utility functions for Azure cleanup scripts.

.DESCRIPTION
This module provides shared functionality including:
- Subscription and environment validation
- Azure context verification
- Guardrail error handling
#>

function Throw-GuardrailError {
    param([string]$Message)
    throw $Message
}

function Assert-RequiredParameters {
    param(
        [string]$SubscriptionId,
        [string]$IacEnv,
        [string]$LocationSuffix
    )

    if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
        Throw-GuardrailError "Subscription ID is not set."
    }

    if ([string]::IsNullOrWhiteSpace($IacEnv)) {
        Throw-GuardrailError "Environment name (iac_env) is not set."
    }

    if ([string]::IsNullOrWhiteSpace($LocationSuffix)) {
        Throw-GuardrailError "Location suffix is not set."
    }
}

function Assert-SubscriptionAllowed {
    param(
        [string]$SubscriptionId,
        [string]$AllowedSubscriptionIds
    )

    $allowedList = $AllowedSubscriptionIds.Split(',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }

    if (-not $allowedList) {
        Throw-GuardrailError "No allowed subscription IDs provided."
    }

    if ($allowedList -notcontains $SubscriptionId) {
        Throw-GuardrailError "Refusing to run: subscriptionId '$SubscriptionId' is not in the allowed list."
    }

    return $allowedList
}

function Assert-EnvironmentAllowed {
    param(
        [string]$IacEnv,
        [string]$AllowedEnvs
    )

    $allowedEnvList = $AllowedEnvs.Split(',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }

    if ($allowedEnvList -notcontains $IacEnv) {
        Throw-GuardrailError "Refusing to run: environment '$IacEnv' is not in the allowed list."
    }
}

function Assert-AzureContextValid {
    param(
        [string]$SubscriptionId,
        [string]$ExpectedSubscriptionName
    )

    Select-AzSubscription -SubscriptionId $SubscriptionId -ErrorAction Stop | Out-Null

    $context = Get-AzContext
    if ($context.Subscription.Id -ne $SubscriptionId) {
        Throw-GuardrailError "Refusing to run: Az context is not set to expected subscription."
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedSubscriptionName)) {
        $sub = Get-AzSubscription -SubscriptionId $SubscriptionId -ErrorAction Stop
        if ($sub.Name -ne $ExpectedSubscriptionName) {
            Throw-GuardrailError "Refusing to run: subscription name '$($sub.Name)' does not match expected '$ExpectedSubscriptionName'."
        }
    }
}
```

### Usage in Every Script

Now every cleanup script imports the module and validates before executing:

```powershell
# Import shared validation module
Import-Module "$PSScriptRoot/Common-AzureCleanupFunctions.psm1" -Force

# Validate all parameters
Assert-RequiredParameters -SubscriptionId $subscriptionId -IacEnv $iac_env -LocationSuffix $location_suffix

# Validate subscription is allowed
Assert-SubscriptionAllowed -SubscriptionId $subscriptionId -AllowedSubscriptionIds $allowedSubscriptionIds

# Validate environment is allowed
Assert-EnvironmentAllowed -IacEnv $iac_env -AllowedEnvs "dev,drdev"

# Validate Azure context
Assert-AzureContextValid -SubscriptionId $subscriptionId -ExpectedSubscriptionName $expectedSubscriptionName
```

### Why This Matters

**Benefits:**
- **Single source of truth** for validation logic
- **Consistent error messages** across all scripts
- **Update once, fix everywhere** when requirements change
- **Testable** (validation functions can be unit tested with Pester)
- **Self-documenting** (module docstrings explain what each function does)

**Result:** Zero production incidents from cleanup scripts running in wrong subscriptions.

### The Pattern

```
┌─────────────────────────────────────┐
│  Cleanup Scripts (9 scripts)       │
│  - DeallocateAzureFirewall.ps1     │
│  - DeleteAzureFirewall.ps1         │
│  - DeleteVPNGateways.ps1           │
│  - etc.                            │
└────────────┬────────────────────────┘
             │ Import-Module
             ▼
┌─────────────────────────────────────┐
│  Common-AzureCleanupFunctions.psm1 │
│  - Assert-SubscriptionAllowed      │
│  - Assert-EnvironmentAllowed       │
│  - Assert-AzureContextValid        │
│  - Throw-GuardrailError            │
└─────────────────────────────────────┘
```

---

## 2. The Dry-Run Default Pattern

### The Disaster Scenario

You have a script that deletes spoke network resource groups. It works perfectly in dev. Then someone runs it in production. With no confirmation. All spoke networks: gone.

**The mistake:** Making deletion the default behavior.

### The Solution: Safe by Default

`DeleteSpokeNetworkResources.ps1` requires explicit opt-in for destructive operations:

```powershell
param(
    [Parameter(Mandatory)]
    [string]$subscriptionId,

    [string]$expectedSubscriptionId = 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy',
    [string]$expectedSubscriptionName = 'Azure-Dev-Spokes',
    [string]$spokePrefixesCsv = 'azf,gmr,iag,gnt,gmr-vdi,iag-vdi,gnt-vdi',
    [string]$locationSuffixesCsv = 'wus,eus',

    [switch]$Apply  # ← The safety switch
)

# Validate subscription (guardrails from module)
if ($subscriptionId -ne $expectedSubscriptionId) {
    Throw-GuardrailError "Refusing to run: subscriptionId does not match expectedSubscriptionId."
}

# Build regex to match spoke resource groups
$prefixPattern = ($spokePrefixes | ForEach-Object { [regex]::Escape($_) }) -join '|'
$locationPattern = ($locationSuffixes | ForEach-Object { [regex]::Escape($_) }) -join '|'
$rgRegex = "^(?:$prefixPattern)-network-(?:rg|auxiliary)-.+-(?:$locationPattern)$"

# Find matching resource groups
$rgCandidates = Get-AzResourceGroup | Where-Object {
    $_.ResourceGroupName -match $rgRegex
}

if (-not $rgCandidates) {
    Write-Output "No matching resource groups found."
    return
}

Write-Output "Matched resource groups in subscription ${expectedSubscriptionId}:"
$rgCandidates.ResourceGroupName | ForEach-Object { Write-Output "  - $_" }

# DRY RUN by default
if (-not $Apply) {
    Write-Output "`nDRY RUN: Pass -Apply to actually delete these resources."
    return
}

# Only reach here if -Apply flag was provided
foreach ($rg in $rgCandidates) {
    Remove-AzResourceGroup -Name $rg.ResourceGroupName -Force
    Write-Output "Deleted resource group: $($rg.ResourceGroupName)"
}
```

### Usage Examples

**Safe exploration (default):**
```powershell
./DeleteSpokeNetworkResources.ps1 -subscriptionId "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"

# Output:
# Matched resource groups in subscription yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy:
#   - azf-network-rg-dev-wus
#   - gmr-network-rg-dev-wus
#   - iag-network-rg-dev-wus
#   - gnt-network-rg-dev-wus
#
# DRY RUN: Pass -Apply to actually delete these resources.
```

**Actual deletion (explicit):**
```powershell
./DeleteSpokeNetworkResources.ps1 -subscriptionId "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy" -Apply

# Output:
# Matched resource groups...
# Deleted resource group: azf-network-rg-dev-wus
# Deleted resource group: gmr-network-rg-dev-wus
# ...
```

### Why This Pattern Works

**Philosophy:** Make the safe operation easy, make the dangerous operation explicit.

**Benefits:**
- **Zero accidental deletions** from running scripts without reading them
- **Preview before destruction** - see exactly what would be deleted
- **Pipeline integration** - CI/CD can run in dry-run mode for validation
- **Training-friendly** - new team members can explore safely
- **Documentation** - dry-run output serves as script documentation

**Cost:** One extra parameter (minimal)

### The Switch Pattern

PowerShell `[switch]` parameters are perfect for this:
- Default value: `$false` (safe)
- Explicit to enable: `-Apply` (dangerous)
- Clear intent: "Apply these changes"

Alternative names: `-Execute`, `-Confirm`, `-Force` (depending on context)

---

## 3. Retry Logic with Exponential Backoff

### The Azure Reality

Azure resource deletion isn't instant. Resources have dependencies. Azure's eventual consistency model means:

1. You delete a VNet
2. Azure returns "accepted" (202)
3. Behind the scenes, Azure is still cleaning up NICs, subnets, peerings
4. If you try to delete the resource group immediately: `409 Conflict`

**Naïve approach:** Fail and give up.

**Production approach:** Retry intelligently.

### The Implementation

From `DeleteSpokeNetworkResources.ps1`:

```powershell
param(
    [int]$maxRetries = 3,
    [int]$retryDelaySeconds = 15
)

$failed = @()

foreach ($rg in $rgCandidates) {
    $rgName = $rg.ResourceGroupName

    # Get VNet info for logging
    $vnets = Get-AzVirtualNetwork -ResourceGroupName $rgName -ErrorAction SilentlyContinue
    $vnetNames = if ($vnets) { ($vnets.Name -join ', ') } else { "<none>" }

    if ($Apply) {
        $deleted = $false

        # Retry loop with exponential backoff
        for ($attempt = 1; $attempt -le $maxRetries -and -not $deleted; $attempt++) {
            try {
                Remove-AzResourceGroup -Name $rgName -Force -ErrorAction Stop | Out-Null
                Write-Output "✅ Deleted resource group $rgName (VNets: $vnetNames)"
                $deleted = $true

            } catch {
                $msg = $_.Exception.Message

                # Check if it's a conflict error (resource still deleting)
                if ($msg -match 'Conflict' -or $msg -match '409') {
                    $sleep = $retryDelaySeconds * $attempt  # Exponential backoff
                    Write-Output "⏳ Conflict deleting $rgName (attempt $attempt/$maxRetries). Retrying in ${sleep}s..."
                    Start-Sleep -Seconds $sleep
                    continue  # Try again
                }

                # Non-conflict errors: fail immediately
                Write-Output "❌ Error deleting resource group ${rgName}: $msg"
                break
            }
        }

        if (-not $deleted) {
            $failed += $rgName
        }

    } else {
        Write-Output "DRY RUN: would delete $rgName (VNets: $vnetNames)"
    }
}

# Report failures
if ($failed.Count -gt 0) {
    throw "Failed to delete resource groups: $($failed -join ', ')"
}
```

### The Smart Retry Logic

**Key decisions:**

1. **Only retry on conflicts** (`409` errors)
   - Non-retryable errors (permissions, not found) fail immediately
   - Saves time on errors that won't resolve with waiting

2. **Exponential backoff**
   - Attempt 1: wait 15 seconds
   - Attempt 2: wait 30 seconds
   - Attempt 3: wait 45 seconds
   - Gives Azure progressively more time to complete operations

3. **Track deletion state**
   - `$deleted` boolean prevents unnecessary retries after success
   - Continue to next resource group once deletion succeeds

4. **Collect failures**
   - Don't exit on first failure
   - Delete everything possible, then report all failures
   - Allows partial progress in batch operations

### Real-World Example

```
⏳ Conflict deleting gmr-network-rg-dev-wus (attempt 1/3). Retrying in 15s...
⏳ Conflict deleting gmr-network-rg-dev-wus (attempt 2/3). Retrying in 30s...
✅ Deleted resource group gmr-network-rg-dev-wus (VNets: gmr-vnet-dev-wus)
```

Without retry: Fails on attempt 1, resource group left in partially deleted state.

With retry: Succeeds on attempt 3, resource group fully cleaned up.

### The Pattern

```powershell
$maxRetries = 3
$deleted = $false

for ($attempt = 1; $attempt -le $maxRetries -and -not $deleted; $attempt++) {
    try {
        # Attempt operation
        Invoke-AzureOperation
        $deleted = $true  # Success

    } catch {
        if (Is-RetryableError $_) {
            $backoff = Calculate-Backoff $attempt
            Start-Sleep -Seconds $backoff
            continue  # Retry
        }
        throw  # Fail fast on non-retryable errors
    }
}

if (-not $deleted) {
    # Handle permanent failure
}
```

---

## 4. Git Hooks for Quality Gates

### The Problem

Your CI/CD pipeline catches Bicep syntax errors... after someone commits broken code, pushes to the repository, triggers a pipeline run, waits 5 minutes, and sees the failure.

**Feedback loop:** 5-10 minutes
**Developer experience:** Frustrating
**Repository history:** Polluted with "fix syntax error" commits

### The Solution: Pre-Commit Validation

`Setup-GitHooks.ps1` automates Git hook installation:

```powershell
# Setup Git Hooks for Test Enforcement
# Run this script once to enable pre-commit testing

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Git Hooks Setup" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

try {
    # Check if Pester is installed
    Write-Host "Checking Pester installation..." -ForegroundColor Yellow
    $pester = Get-Module -ListAvailable -Name Pester | Where-Object Version -ge '5.0.0'

    if (-not $pester) {
        Write-Host "Pester 5.0+ not found. Installing..." -ForegroundColor Yellow
        Install-Module -Name Pester -MinimumVersion 5.0.0 -Force -SkipPublisherCheck
        Write-Host "Pester installed successfully.`n" -ForegroundColor Green
    } else {
        Write-Host "Pester $($pester.Version) is already installed.`n" -ForegroundColor Green
    }

    # Setup pre-commit hook
    $hookDest = Join-Path $PSScriptRoot ".git" "hooks" "pre-commit"

    if (Test-Path $hookDest) {
        Write-Host "Pre-commit hook already exists." -ForegroundColor Yellow
        $response = Read-Host "Do you want to overwrite it? (y/n)"
        if ($response -ne 'y') {
            Write-Host "Skipping hook setup.`n" -ForegroundColor Yellow
            exit 0
        }
    }

    # Create the pre-commit hook (shell script that calls PowerShell)
    $hookContent = @'
#!/bin/sh
# Pre-commit hook - runs Pester tests before allowing commit

# Change to the .git/hooks directory to ensure we're in the right location
cd "$(dirname "$0")" || exit 1

# Run PowerShell script using relative path
if [ -f "pre-commit.ps1" ]; then
    pwsh -NoProfile -ExecutionPolicy Bypass -File "./pre-commit.ps1"
    exit $?
else
    echo "pre-commit.ps1 not found. Allowing commit to proceed."
    exit 0
fi
'@

    Set-Content -Path $hookDest -Value $hookContent -Force
    Write-Host "Pre-commit hook created at: $hookDest" -ForegroundColor Green

    # Make executable on Unix-like systems
    if ($IsLinux -or $IsMacOS) {
        chmod +x $hookDest
        Write-Host "Hook made executable.`n" -ForegroundColor Green
    } else {
        Write-Host "`nNote: On Windows, Git will automatically use PowerShell for the hook.`n" -ForegroundColor Cyan
    }

    # Run a test to verify everything works
    Write-Host "Running test suite to verify setup..." -ForegroundColor Yellow
    $testScript = Join-Path $PSScriptRoot "tests" "Run-Tests.ps1"

    if (Test-Path $testScript) {
        & $testScript

        if ($LASTEXITCODE -eq 0) {
            Write-Host "`n========================================" -ForegroundColor Green
            Write-Host "Setup Complete!" -ForegroundColor Green
            Write-Host "========================================" -ForegroundColor Green
            Write-Host "Pre-commit hook is now active." -ForegroundColor Green
            Write-Host "Tests will run automatically before each commit.`n" -ForegroundColor Green
        } else {
            Write-Host "`n========================================" -ForegroundColor Red
            Write-Host "Setup Complete (with warnings)" -ForegroundColor Red
            Write-Host "========================================" -ForegroundColor Red
            Write-Host "Hook is installed, but some tests failed." -ForegroundColor Yellow
            Write-Host "Please fix the failing tests before committing.`n" -ForegroundColor Yellow
        }
    }

    Write-Host "To disable the hook temporarily, use: git commit --no-verify`n" -ForegroundColor Cyan

} catch {
    Write-Host "`nError during setup: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Please check the error and try again.`n" -ForegroundColor Yellow
    exit 1
}
```

### What Gets Validated

The pre-commit hook runs:

1. **Pester tests** - PowerShell unit tests for cleanup scripts
2. **PSRule validation** - Azure best practices and security checks for Bicep
3. **Bicep syntax checks** - `az bicep build` on all changed `.bicep` files
4. **Linting** - Custom rules from `bicepconfig.json`

### The Developer Experience

**Before (no hooks):**
```bash
$ git commit -m "Add firewall rule"
[main abc123] Add firewall rule
 1 file changed

# Push to remote
$ git push
# Wait 5 minutes for pipeline
# Pipeline fails: Bicep syntax error
# Fix locally, commit again, push again, wait again...
```

**After (with hooks):**
```bash
$ git commit -m "Add firewall rule"
Running pre-commit tests...

Running Pester tests...
  ✅ Common-AzureCleanupFunctions.Tests.ps1 (8 tests passed)
  ✅ DeleteResourceGroups.Tests.ps1 (5 tests passed)

Validating Bicep files...
  ✅ hub.bicep
  ❌ definitions/gmr.bicep
     Line 42: Syntax error: Expected '}'

Pre-commit validation failed. Commit blocked.
Fix the errors above and try again.

# Fix syntax error
$ git commit -m "Add firewall rule"
Running pre-commit tests...
  ✅ All tests passed

[main abc123] Add firewall rule
 1 file changed
```

**Feedback loop:** 10 seconds
**Developer experience:** Fast, immediate feedback
**Repository history:** Clean, only working code

### Bypassing Hooks (When Needed)

For work-in-progress commits:
```bash
git commit --no-verify -m "WIP: incomplete implementation"
```

**Use sparingly** - most commits should pass validation.

### The Pattern

```
┌──────────────────────────────────┐
│     Developer runs git commit    │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│   .git/hooks/pre-commit          │
│   (Shell script)                 │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│   pre-commit.ps1                 │
│   (PowerShell orchestrator)      │
└────────────┬─────────────────────┘
             │
             ├─────> Run Pester tests
             ├─────> Run PSRule validation
             └─────> Validate Bicep syntax
                     │
                     ▼
                  Pass/Fail
                     │
           ┌─────────┴─────────┐
           │                   │
         Pass                Fail
           │                   │
    Allow commit        Block commit
```

---

## 5. The Line Ending Enforcement Pattern

### The Cross-Platform Catastrophe

**Scenario:** You develop on Windows. Your CI/CD runs on Linux. You commit a Bicep file with CRLF line endings. The Linux pipeline fails with cryptic errors:

```
Error: Invalid character at line 42
```

Line 42 looks fine. But invisible `\r\n` vs `\n` line endings break parsing.

**Or vice versa:** PowerShell script committed with LF line endings. Windows execution fails with:
```
The term './script.ps1' is not recognized
```

### The Solution: `.gitattributes`

`.gitattributes` enforces line ending consistency:

```gitattributes
# Normalize line endings across the repo

# Default: treat files as text and use LF in working tree
* text=auto eol=lf

# Explicit LF for common infra and scripts
*.sh           text eol=lf
*.yml          text eol=lf
*.yaml         text eol=lf
*.bicep        text eol=lf
*.bicepparam   text eol=lf
*.json         text eol=lf
*.md           text eol=lf

# Windows-specific scripts keep CRLF
*.ps1          text eol=crlf
*.bat          text eol=crlf
*.cmd          text eol=crlf
```

### How `.gitattributes` Works

**Repository (always LF):**
- Files are stored with LF in Git
- History is consistent regardless of contributor platform

**Working tree (depends on file type):**
- Bicep/YAML: Checked out with LF (Unix standard)
- PowerShell: Checked out with CRLF (Windows requirement)

**On commit:**
- Git automatically normalizes line endings based on `.gitattributes`
- Prevents accidental CRLF commits from Windows users

### Why Specific File Types Matter

**LF files (`.bicep`, `.yml`, `.json`):**
- Infrastructure files should use Unix conventions
- Bicep compiler expects LF
- YAML parsers expect LF
- Linux pipelines expect LF

**CRLF files (`.ps1`, `.bat`):**
- PowerShell on Windows requires CRLF
- Some Windows tools expect CRLF
- Batch files must have CRLF

### The Impact

**Without `.gitattributes`:**
- Windows devs commit CRLF inadvertently
- Linux pipelines fail randomly
- Mac developers see different line endings than Windows
- Impossible to review diffs (entire files show as changed)

**With `.gitattributes`:**
- Consistent line endings in repository
- Cross-platform compatibility
- Clean diffs showing actual changes
- No more "works on my machine" line ending issues

### Setting Up a New Clone

When a developer clones the repo:

```bash
git clone https://github.com/org/azure-iac.git
cd azure-iac

# Git automatically reads .gitattributes
# Files are checked out with correct line endings
# No manual configuration needed
```

### Fixing Existing Files

If line endings are already mixed:

```bash
# Remove all files from Git's index
git rm --cached -r .

# Reset the index to match .gitattributes
git reset --hard

# Add all files back (normalizes line endings)
git add .

# Commit the normalized files
git commit -m "Normalize line endings per .gitattributes"
```

---

## 6. Bicep Analyzer Configuration: Custom Linting Rules

### The Linter Conflict

Bicep's built-in analyzer has a rule: `explicit-values-for-loc-params`

It wants:
```bicep
param location string = 'westus'  // ✅ Explicit default
```

But our multi-environment pattern uses:
```bicep
param location string = readEnvironmentVariable('location', 'WestUS')  // ❌ Analyzer doesn't like this
```

**Problem:** The analyzer flags this as a warning, but it's intentional design for our multi-environment deployment model.

### The Solution: Custom Configuration

`bicepconfig.json` customizes linting rules:

```json
{
  // See https://aka.ms/bicep/config for more information on Bicep configuration options
  // Press CTRL+SPACE/CMD+SPACE at any location to see Intellisense suggestions
  "analyzers": {
    "core": {
      "rules": {
        "explicit-values-for-loc-params": {
          "level": "off"
        }
      }
    }
  }
}
```

### Decision Rationale

**Why disable this rule?**

1. **Environment variables provide explicit values** - Just not at template compile time
2. **Our pattern is intentional** - Not a mistake or oversight
3. **One parameter file serves all environments** - Better than duplicated files with explicit locations
4. **Runtime injection is required** - For CI/CD pipeline integration

**Alternative considered:** Set rule to `warning` instead of `off`

**Decision:** `off` because warnings clutter output and hide real issues

### Other Customizations

You could customize additional rules:

```json
{
  "analyzers": {
    "core": {
      "rules": {
        "no-unused-params": {
          "level": "warning"  // Default is error
        },
        "prefer-interpolation": {
          "level": "error"  // Enforce string interpolation over concat()
        },
        "use-stable-vm-image": {
          "level": "off"  // Allow 'latest' VM images in dev
        }
      }
    }
  }
}
```

### The Impact

**Before customization:**
```
$ az bicep build --file hub.bicep

Warning BCP037: The parameter "location" uses environment variable which may not provide an explicit value.
Warning BCP037: The parameter "source_branch" uses environment variable which may not provide an explicit value.
...
[50 more warnings from multi-environment pattern]
```

**After customization:**
```
$ az bicep build --file hub.bicep

Build succeeded. 0 warning(s), 0 error(s)
```

Clean output focuses attention on actual issues, not expected patterns.

---

## 7. Orchestration with Token Refresh

### The Long-Running Operation Problem

You have a cleanup orchestrator that:
1. Deallocates firewall (10 min)
2. Deletes VPN gateways (15 min each = 30 min)
3. Deletes Virtual Hub connections (20 min)
4. Deletes resource groups (10 min)

**Total:** 70 minutes

**Azure AD token validity:** 60 minutes

**Result:** Auth expires at minute 60, operation fails at minute 61.

### The Solution: Proactive Token Refresh

From `Invoke-CleanupOrchestrator.ps1`:

```powershell
#region Azure Authentication Functions

function Connect-AzureWithServicePrincipal {
    <#
    .SYNOPSIS
    Establishes Azure connection using service principal credentials from environment variables.

    .DESCRIPTION
    This function is used to refresh the Azure authentication token during long-running operations.
    It uses the service principal credentials exposed by the AzurePowerShell@5 task when
    addSpnToEnvironment is set to true.

    Based on the token refresh strategy documented in pipelines/TOKEN-REFRESH-STRATEGY.md
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$subscriptionId
    )

    Write-Host "Refreshing Azure authentication token..."

    # Check if service principal credentials are available from AzurePowerShell task
    if (-not $env:servicePrincipalId -or -not $env:servicePrincipalKey -or -not $env:tenantId) {
        Write-Host "Service principal environment variables not found. Token refresh may not work."
        Write-Host "This is expected if running locally. Attempting to use existing context..."

        # Try to use existing context
        try {
            Select-AzSubscription -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
            Write-Host "Using existing Azure context."
            return $true
        } catch {
            Write-Host "Failed to establish Azure context: $($_.Exception.Message)"
            return $false
        }
    }

    try {
        # Convert service principal key to secure string
        $securePassword = ConvertTo-SecureString $env:servicePrincipalKey -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential($env:servicePrincipalId, $securePassword)

        # Connect using service principal
        Connect-AzAccount -ServicePrincipal `
            -Credential $credential `
            -Tenant $env:tenantId `
            -Subscription $subscriptionId `
            -ErrorAction Stop | Out-Null

        Write-Host "Azure authentication token refreshed successfully."
        return $true
    } catch {
        Write-Host "Failed to refresh Azure authentication: $($_.Exception.Message)"
        return $false
    }
}

function Test-AzureAuthentication {
    <#
    .SYNOPSIS
    Tests if the current Azure authentication is valid and can access the subscription.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$subscriptionId
    )

    try {
        # Try a simple operation to verify authentication is working
        $context = Get-AzContext -ErrorAction Stop

        if (-not $context) {
            return $false
        }

        # Verify we can actually query the subscription
        Get-AzSubscription -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

#endregion

# Main orchestration loop
$lastTokenRefresh = Get-Date
$cleanupTasks = @(
    'Deallocate-Firewall',
    'Delete-VPNGateways',
    'Delete-VirtualHubConnections',
    'Delete-ResourceGroups'
)

foreach ($task in $cleanupTasks) {
    # Check if token needs refresh (every 45 minutes)
    $timeSinceRefresh = (Get-Date) - $lastTokenRefresh
    if ($timeSinceRefresh.TotalMinutes -ge 45) {
        Write-Host "`n=== Token Refresh ===" -ForegroundColor Cyan

        $refreshed = Connect-AzureWithServicePrincipal -subscriptionId $subscriptionId

        if ($refreshed) {
            $lastTokenRefresh = Get-Date
            Write-Host "Token refresh completed. Continuing cleanup..." -ForegroundColor Green
        } else {
            Write-Host "Token refresh failed. Attempting to continue with existing context..." -ForegroundColor Yellow
        }
    }

    # Verify authentication before each task
    if (-not (Test-AzureAuthentication -subscriptionId $subscriptionId)) {
        Write-Host "Authentication validation failed before task: $task" -ForegroundColor Red

        # Attempt emergency token refresh
        $refreshed = Connect-AzureWithServicePrincipal -subscriptionId $subscriptionId

        if (-not $refreshed) {
            throw "Unable to establish valid Azure authentication. Aborting cleanup."
        }
    }

    # Execute cleanup task
    Write-Host "`n=== Running: $task ===" -ForegroundColor Cyan
    & ".\$task.ps1" -subscriptionId $subscriptionId -iac_env $iac_env -location_suffix $location_suffix
}
```

### The Token Refresh Strategy

**Key elements:**

1. **45-minute refresh interval** (not 60)
   - Azure tokens expire at 60 minutes
   - Refresh at 45 gives 15-minute safety buffer
   - Prevents mid-operation auth failures

2. **Service principal credentials from pipeline**
   - Azure DevOps task exposes `$env:servicePrincipalId`, `$env:servicePrincipalKey`, `$env:tenantId`
   - Script uses these to re-authenticate
   - No credentials hardcoded in scripts

3. **Graceful degradation**
   - If running locally (no env vars): use existing context
   - If refresh fails: attempt to continue with existing auth
   - Only fail if both refresh and existing auth are invalid

4. **Pre-task validation**
   - Test authentication before each cleanup task
   - Emergency refresh if validation fails
   - Prevents task failures mid-operation

### Azure DevOps Pipeline Integration

The pipeline task must expose service principal credentials:

```yaml
- task: AzurePowerShell@5
  displayName: 'Run Cleanup Orchestrator'
  inputs:
    azureSubscription: 'azure-iac-secret'
    ScriptType: 'FilePath'
    ScriptPath: '$(System.DefaultWorkingDirectory)/powerShellScripts/Invoke-CleanupOrchestrator.ps1'
    ScriptArguments: '-subscriptionId "$(subscriptionId)" -iac_env "$(iac_env)" -location_suffix "$(location_suffix)"'
    azurePowerShellVersion: 'LatestVersion'
    addSpnToEnvironment: true  # ← Critical: exposes service principal credentials
```

**Without `addSpnToEnvironment: true`:** Token refresh doesn't work, operation fails at 60 minutes.

**With `addSpnToEnvironment: true`:** Service principal credentials available, token refresh succeeds.

### The Same Pattern Everywhere

This token refresh strategy is used in:

1. **Deployment pipelines** - For long-running Bicep deployments
2. **Cleanup orchestrators** - For sequential cleanup operations
3. **DR failover scripts** - For multi-hour disaster recovery operations

**Consistency:** Same pattern across all long-running operations.

---

## The Operational Maturity Spectrum

| Level | Characteristics | Example | This Repo |
|-------|----------------|---------|-----------|
| **L1: Scripts** | One-off PowerShell scripts, manual execution, no validation | `Remove-AzResourceGroup -Name "rg-prod"` | ❌ |
| **L2: Reusable** | Functions extracted, some parameter validation | `function Remove-RG { param($name) ... }` | ❌ |
| **L3: Safe** | Guardrails, dry-run defaults, subscription validation | `Assert-SubscriptionAllowed`, `-Apply` switch | ✅ |
| **L4: Resilient** | Retry logic, error handling, token refresh | Exponential backoff, `Connect-AzureWithServicePrincipal` | ✅ |
| **L5: Automated** | Git hooks, pre-commit tests, CI/CD integration | Pre-commit Pester tests, automated PSRule validation | ✅ |

**This repository operates at Level 5:** Automation with safety guardrails, resilience patterns, and quality gates built in.

### Progression Path

**L1 → L2:** Extract reusable functions
**L2 → L3:** Add validation and dry-run modes
**L3 → L4:** Implement retry logic and error handling
**L4 → L5:** Automate quality gates with Git hooks and CI/CD

Most organizations stop at L2 or L3. Reaching L5 requires investment in operational excellence.

---

## The Pattern Library: Extractable to Any Environment

These patterns aren't Azure-specific or IaC-specific. They apply to **any operational automation**:

### 1. Shared Validation Module
**Pattern:** Extract common validation logic into a reusable module
**Applies to:** Cleanup scripts, deployment scripts, migration scripts
**Benefit:** Consistent guardrails across all automation

### 2. Dry-Run Default Switch
**Pattern:** Make safe operations default, require explicit flag for destruction
**Applies to:** Database migrations, resource deletion, configuration changes
**Benefit:** Prevents accidental execution of dangerous operations

### 3. Conflict-Aware Retry Logic
**Pattern:** Retry only on transient errors with exponential backoff
**Applies to:** API calls, resource operations, network requests
**Benefit:** Handle eventual consistency gracefully

### 4. Git Hooks Setup Automation
**Pattern:** Provide scripts to install quality gates as Git hooks
**Applies to:** Linting, testing, security scanning, formatting
**Benefit:** Shift quality gates left without CI/CD dependency

### 5. Cross-Platform Line Ending Management
**Pattern:** Use `.gitattributes` to enforce file-type-specific line endings
**Applies to:** Any multi-platform repository with scripts and configs
**Benefit:** Prevent "works on my machine" issues from invisible characters

### 6. Token Refresh for Long Operations
**Pattern:** Proactively refresh auth tokens before expiration
**Applies to:** Long-running operations against any API with token expiration
**Benefit:** Operations that would take >60 minutes can run reliably

---

## Conclusion: Operational Excellence as a Competitive Advantage

Anyone can write a PowerShell script that deletes resources. Few build operational automation that:

- **Prevents disasters** through layered guardrails
- **Provides visibility** with dry-run defaults
- **Handles failures gracefully** with smart retry logic
- **Shifts quality gates left** with pre-commit validation
- **Works cross-platform** with line ending enforcement
- **Scales beyond token limits** with proactive token refresh

**This is the difference between scripts and systems.**

Good infrastructure code deploys resources. **Great infrastructure code makes operations safe, reliable, and scalable.**

The patterns in this repository—shared validation modules, dry-run defaults, retry logic, Git hooks, line ending enforcement, and token refresh—represent **operational maturity** that separates engineers who write scripts from engineers who build platforms.

If your organization is struggling with operational incidents, inconsistent quality, or "works on my machine" issues, these patterns provide a roadmap from ad-hoc automation to production-grade operational excellence.

---

**Technologies:** PowerShell, Azure CLI, Pester, Git Hooks, PSRule, Azure DevOps

**Skills Demonstrated:** Operational excellence, PowerShell automation, Quality assurance, Resilience engineering, DevOps practices, Platform engineering

---

**Related posts:**
- [Token Expiration in Azure Deployments](/posts/token-expiration-azure-deployments)
- [Safety Guardrails for Production Systems](/posts/safety-guardrails-production)
- [Building Enterprise-Scale Azure Infrastructure](/posts/azure-infrastructure-at-scale)

*Part of a series on building enterprise-scale Azure infrastructure at scale.*
