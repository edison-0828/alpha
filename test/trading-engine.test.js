import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRADING_CONFIG, entryEvaluation, managedExitDecision,
  normalizeTradingConfig, principalRecoveryOrder, rankEntryCandidates
} from '../trading-engine.js';

function token(overrides = {}) {
  return {
    chainId:'56', address:'0xabc', symbol:'TEST', price:1, score:90, action:'试仓',
    quality:'高质量', stage:'确认', liquidity:500_000, holders:20_000, change24h:15,
    metrics:{ exhaustion:false, riskFlags:{ thinLiquidity:false, botLike:false, highDilution:false, concentrated:false, liquidityDrain:false } },
    chainIntel:{ available:false, smartNetUsd:0, largeSwapNetUsd:0 },
    ...overrides
  };
}

test('normalizes auto trading into paper-only execution', () => {
  const config = normalizeTradingConfig({ enabled:true, executionMode:'live', orderUsd:1_000, takePrincipalMultiple:2 });
  assert.equal(config.enabled, true);
  assert.equal(config.executionMode, 'paper');
  assert.equal(config.orderUsd, 1_000);
  assert.equal(config.takePrincipalMultiple, 2);
});

test('accepts a conservative trial-position candidate', () => {
  const result = entryEvaluation(token(), DEFAULT_TRADING_CONFIG);
  assert.equal(result.eligible, true);
  assert.equal(result.blockers.length, 0);
  assert.ok(result.poolImpactPct < DEFAULT_TRADING_CONFIG.maxPoolImpactPct);
});

test('blocks overheated, thin, and structurally risky candidates', () => {
  const result = entryEvaluation(token({
    stage:'过热', liquidity:20_000,
    metrics:{ exhaustion:true, riskFlags:{ thinLiquidity:true, botLike:true, highDilution:false, concentrated:false, liquidityDrain:false } }
  }), DEFAULT_TRADING_CONFIG);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((item) => item.includes('过热')));
  assert.ok(result.blockers.some((item) => item.includes('流动性')));
  assert.ok(result.blockers.some((item) => item.includes('结构性')));
});

test('does not rank tokens already held or managed', () => {
  const tokens = [token(), token({ address:'0xdef', symbol:'SECOND', score:88 })];
  const ranked = rankEntryCandidates(tokens, DEFAULT_TRADING_CONFIG, { '0xabc':{ qty:1 } }, {});
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].token.address, '0xdef');
});

test('sells exactly enough at 2x to recover the original principal', () => {
  const position = { qty:1_000, avgCost:1 };
  const managed = { entryPrice:1, initialCostUsd:1_000, principalRecovered:false, principalRecoveredUsd:0 };
  assert.equal(principalRecoveryOrder(position, managed, 1.99, 2), null);
  const order = principalRecoveryOrder(position, managed, 2, 2);
  assert.equal(order.qty, 500);
  assert.equal(order.expectedProceeds, 1_000);
});

test('hard risk exits before take-principal and stop loss exits below threshold', () => {
  const position = { qty:1_000, avgCost:1 };
  const managed = { entryPrice:1, initialCostUsd:1_000, principalRecovered:false, principalRecoveredUsd:0 };
  const risky = token({ action:'回避', price:2.1 });
  assert.equal(managedExitDecision(risky, position, managed, DEFAULT_TRADING_CONFIG).reason, 'hard-risk');
  const stopped = token({ price:0.87 });
  assert.equal(managedExitDecision(stopped, position, managed, DEFAULT_TRADING_CONFIG).reason, 'stop-loss');
});
