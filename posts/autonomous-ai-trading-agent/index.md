---
title: "How I Built a Bot That Trades Prediction Markets While I Sleep"
date: 2026-02-18
draft: false
description: "Building an autonomous AI trading agent for Polymarket using OpenClaw, Python, and half-Kelly position sizing. Architecture, risk management, and lessons from letting an AI trade real money."
tags: ["AI", "Trading", "Polymarket", "Automation", "Python", "OpenClaw"]
categories: ["AI & Automation"]
---

# How I Built a Bot That Trades Prediction Markets While I Sleep

I'm a cloud architect by day. I build enterprise Azure infrastructure — hub-and-spoke networks, 1,200 files of Bicep IaC, the whole stack.

But at night, I've been building something different: an autonomous AI agent that scans 5,000 prediction markets on Polymarket, identifies mispricings, verifies them through web research, and executes trades — all without me touching a thing.

This is the story of how I built it, the architecture behind it, and what I've learned about letting an AI trade real money.

## Why Prediction Markets?

Prediction markets are binary options on real-world events. "Will X happen by Y date?" You buy tokens priced between 0¢ and 100¢. If the event happens, YES tokens pay $1. If not, NO tokens pay $1.

The interesting part: these markets are priced by crowds. And crowds make mistakes.

A token trading at 95¢ for an event that's already confirmed? That's free money — 5% return in days, not years. A market that swings 15% on news that hasn't changed the underlying probability? That's a mispricing.

The edge isn't prediction. It's **discipline and speed**.

## The Architecture

Here's what the system looks like:

```
┌─────────────────────────────────────────────────────┐
│                    OpenClaw Agent                     │
│                  (Always Running)                     │
├──────────────────┬──────────────────────────────────┤
│                  │                                    │
│   ┌──────────┐   │   ┌────────────┐                  │
│   │ MONITOR  │   │   │ HARVESTER  │                  │
│   │ Scanner  │   │   │  Scanner   │                  │
│   │ (5 min)  │   │   │ (15 min)   │                  │
│   └────┬─────┘   │   └─────┬──────┘                  │
│        │         │         │                          │
│        ▼         │         ▼                          │
│   ┌──────────────┴─────────────────┐                 │
│   │      Research Pipeline         │                 │
│   │   (Brave Search API + LLM)     │                 │
│   └────────────┬───────────────────┘                 │
│                │                                      │
│                ▼                                      │
│   ┌────────────────────────────────┐                 │
│   │     Risk Management Engine     │                 │
│   │  (Half-Kelly + Circuit Breaker)│                 │
│   └────────────┬───────────────────┘                 │
│                │                                      │
│                ▼                                      │
│   ┌────────────────────────────────┐                 │
│   │     Trade Execution Layer      │                 │
│   │  (py-clob-client → Polygon)   │                 │
│   └────────────────────────────────┘                 │
│                                                       │
└─────────────────────────────────────────────────────┘
```

The agent runs on [OpenClaw](https://openclaw.com), an AI agent framework that gives the bot persistent execution, tool access, and autonomous decision-making. It's not a cron job calling an API — it's an AI that reasons about markets.

Let me break down each layer.

## Scanner 1: The Monitor

The Monitor is the opportunity-finder. Every 5 minutes, it scans Polymarket's full market catalog — roughly 5,000 active markets — looking for two signals:

**Price swings** — a market that moved 10%+ in the last hour. Something happened. The question is whether the crowd overreacted.

**Volume spikes** — sudden trading volume on a market that's been quiet. Smart money moving, or retail panic? Either way, it's worth investigating.

```python
def scan_for_opportunities(markets):
    opportunities = []
    
    for market in markets:
        # Price swing detection
        if abs(market.price_change_1h) > 0.10:
            opportunities.append({
                'market': market.id,
                'signal': 'price_swing',
                'magnitude': market.price_change_1h,
                'current_price': market.last_price,
                'volume_24h': market.volume_24h
            })
        
        # Volume spike detection
        if market.volume_1h > (market.avg_hourly_volume * 3):
            opportunities.append({
                'market': market.id,
                'signal': 'volume_spike',
                'volume_ratio': market.volume_1h / market.avg_hourly_volume,
                'current_price': market.last_price
            })
    
    return opportunities
```

When the Monitor flags something, it doesn't trade. It sends the opportunity to the research pipeline.

## Scanner 2: The Harvester

The Harvester is the boring one. And boring is where the money is.

Every 15 minutes, it scans for **near-certainty time-decay plays**: tokens priced between 85¢ and 97¢ where the outcome is almost guaranteed but hasn't resolved yet.

Think of it like picking up pennies — except the steamroller is visible and moving slowly.

```python
def scan_for_harvest(markets):
    candidates = []
    
    for market in markets:
        price = market.last_price
        
        # Sweet spot: high confidence but not yet priced at 99¢
        if 0.85 <= price <= 0.97:
            days_to_expiry = (market.end_date - now()).days
            if days_to_expiry <= 0:
                continue
            
            # Calculate annualized return
            profit_per_token = 1.0 - price
            holding_period_years = days_to_expiry / 365
            annualized = (profit_per_token / price) / holding_period_years
            
            if annualized > 0.15:  # >15% annualized
                candidates.append({
                    'market': market.id,
                    'price': price,
                    'days_to_expiry': days_to_expiry,
                    'annualized_return': annualized,
                    'profit_per_token': profit_per_token
                })
    
    # Sort by annualized return
    return sorted(candidates, key=lambda x: x['annualized_return'], reverse=True)
```

The key filter: **>15% annualized return**. Below that, the capital is better deployed elsewhere. Above that, and the risk-reward makes sense even with a small bankroll.

## The Research Pipeline

This is where most bots fail. They see a number and trade. Mine reads the news first.

Before any trade executes, the agent runs an automated research cycle using the Brave Search API:

1. **Search for recent news** about the market's underlying event
2. **Analyze sentiment and facts** — has anything materially changed?
3. **Cross-reference multiple sources** — one headline isn't enough
4. **Estimate true probability** — independent of the current market price

```python
def research_market(market_question, current_price):
    # Step 1: Search for recent information
    search_results = brave_search(
        query=market_question,
        freshness='pd'  # past day
    )
    
    # Step 2: AI analyzes search results
    analysis = llm_analyze(
        context=search_results,
        prompt=f"""
        Market question: {market_question}
        Current market price: {current_price}
        
        Based on the search results:
        1. What is the most likely outcome?
        2. What is your estimated probability (0-100)?
        3. Is the current price justified?
        4. What risks could change the outcome?
        """
    )
    
    # Step 3: Only proceed if there's a meaningful edge
    estimated_prob = analysis.probability / 100
    edge = estimated_prob - current_price
    
    if abs(edge) < 0.05:  # Less than 5% edge — skip
        return None
    
    return {
        'estimated_probability': estimated_prob,
        'edge': edge,
        'confidence': analysis.confidence,
        'reasoning': analysis.reasoning
    }
```

The 5% minimum edge threshold is critical. Transaction costs, slippage, and model uncertainty eat into small edges. If the AI isn't at least 5 points more confident than the market, we pass.

## Risk Management: Half-Kelly Position Sizing

This is the part that keeps me sleeping at night.

The [Kelly Criterion](https://en.wikipedia.org/wiki/Kelly_criterion) is a formula that tells you the optimal bet size to maximize long-term growth. Full Kelly is mathematically optimal but practically terrifying — the variance will destroy you psychologically.

So I use **Half-Kelly**: half the Kelly-optimal size. You give up ~25% of the theoretical growth rate but cut variance roughly in half.

```python
def calculate_position_size(bankroll, probability, market_price, side):
    """
    Half-Kelly position sizing for binary options.
    
    Kelly fraction: f* = (p * b - q) / b
    where:
        p = estimated probability of winning
        q = 1 - p
        b = net odds (payout / cost - 1)
    """
    if side == 'YES':
        p = probability
        cost = market_price
    else:
        p = 1 - probability
        cost = 1 - market_price
    
    q = 1 - p
    b = (1 - cost) / cost  # net odds
    
    kelly_fraction = (p * b - q) / b
    
    # Half-Kelly for reduced variance
    half_kelly = kelly_fraction / 2
    
    # Safety clamps
    half_kelly = max(0, half_kelly)         # never negative
    half_kelly = min(half_kelly, 0.10)      # never more than 10% of bankroll
    
    position_size = bankroll * half_kelly
    
    # Minimum trade size check
    if position_size < 1.0:  # Less than $1 — not worth the gas
        return 0
    
    return round(position_size, 2)
```

The **10% cap** is a hard ceiling. Even if Kelly says bet 40% of the bankroll, I won't. Overconfidence kills accounts.

## Circuit Breaker

Beyond Kelly sizing, there's a circuit breaker that halts all trading if things go sideways:

```python
class CircuitBreaker:
    def __init__(self, max_daily_loss_pct=0.15, max_open_positions=10):
        self.max_daily_loss_pct = max_daily_loss_pct
        self.max_open_positions = max_open_positions
    
    def check(self, portfolio):
        # Stop trading if daily losses exceed 15%
        if portfolio.daily_pnl_pct < -self.max_daily_loss_pct:
            return False, "Daily loss limit hit"
        
        # Stop trading if too many open positions
        if len(portfolio.open_positions) >= self.max_open_positions:
            return False, "Max positions reached"
        
        # Stop trading if bankroll drops below minimum
        if portfolio.balance < 10.0:
            return False, "Bankroll below minimum"
        
        return True, "OK"
```

Three conditions halt the bot: 15% daily loss, 10 open positions, or bankroll below $10. If any trigger fires, the bot stops opening new positions and sends me a notification.

## The Execution Layer

Trades execute on Polygon (Polymarket's L2) using USDC.e. The bot uses `py-clob-client` to interact with the Polymarket CLOB (Central Limit Order Book):

```python
def execute_trade(market_id, side, size, price):
    """
    Place a limit order on Polymarket's CLOB.
    Uses GTC (Good Till Cancelled) orders.
    """
    order = client.create_and_post_order(
        OrderArgs(
            token_id=market_id,
            price=price,
            size=size,
            side=side,
            order_type=OrderType.GTC
        )
    )
    
    # Log everything
    log_trade({
        'timestamp': datetime.utcnow().isoformat(),
        'market': market_id,
        'side': side,
        'size': size,
        'price': price,
        'order_id': order.id,
        'status': order.status
    })
    
    # Notify — I want to know what it did
    notify(f"Trade executed: {side} {size} @ {price} on {market_id}")
    
    return order
```

The notification part is non-negotiable. The bot is autonomous — it decides and executes on its own — but I see every trade within seconds. Trust but verify.

## The Philosophy

Building this taught me something I already knew from infrastructure work: **discipline beats intelligence**.

A disciplined system with modest edge will outperform a brilliant system with no risk management. Every time.

The core principles:

- **Never bet more than Kelly says.** Actually, bet half of what Kelly says.
- **Always research before trading.** The 30-second delay for web search has never cost me an opportunity, but it's prevented bad trades.
- **Log everything.** Every scan, every research query, every trade, every notification. You can't improve what you don't measure.
- **Structural edge > prediction edge.** I'm not trying to predict elections. I'm looking for tokens priced at 92¢ when the event already happened. That's not prediction — it's arbitrage against slow markets.
- **Small bankroll, small bets.** Starting with ~$130. If the system proves itself, the bankroll grows. If it doesn't, I've learned for the cost of a nice dinner.

## Where I Am Now

Let me be honest: it's early.

The system is running 24/7. The scanners are finding opportunities. Trades are executing. But no markets have resolved yet — so there's no realized P&L to report.

What I can tell you:

- The bot has been scanning ~5,000 markets every 5 minutes without failures
- The Harvester has identified several high-confidence time-decay plays in the 85-97¢ range
- Position sizing is conservative — no single position exceeds 10% of bankroll
- The research pipeline has caught several false positives that raw price data would have traded on

The real test comes when markets resolve and I have actual returns to measure against. Until then, this is an experiment in autonomous decision-making with real money on the line.

## What's Next

This is version 1. Here's what's on the roadmap:

**Weekly performance reviews** — once markets start resolving, I'll run weekly analysis on hit rate, average edge captured, and Kelly accuracy. The system needs to prove itself with data, not vibes.

**Expanding to more platforms** — Polymarket is one prediction market. Kalshi is another, with different market structures and regulatory status. The architecture is designed to be platform-agnostic — swap the execution layer, keep everything else.

**Better research pipeline** — the current Brave Search integration works, but I want to add specialized data sources. Sports data APIs for sports markets. Polling aggregators for political markets. Weather data for weather markets. Domain-specific information beats general web search.

**Portfolio-level risk management** — right now, risk management is per-trade. The next step is portfolio-level correlation analysis. If I have 5 positions that all depend on the same underlying variable, that's concentrated risk even if each position is small.

**Open-sourcing the framework** — once the system has enough track record, I plan to write up the full framework with sanitized code. The edge isn't in the code — it's in the execution discipline. Sharing the architecture helps everyone build better trading systems.

---

If you're thinking about building something similar, my advice is simple: start with risk management. Not the scanner. Not the execution. The risk management. Because the bot that loses slowly is the bot that survives long enough to win.

The system architecture is the same pattern I use for enterprise infrastructure: defense in depth, circuit breakers at every layer, and the assumption that something will go wrong.

The only difference is that in infrastructure, a failed deployment costs time. In trading, a failed risk check costs money.

Build accordingly.
