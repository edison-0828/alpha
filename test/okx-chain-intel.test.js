import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOkxPush } from '../okx-chain-intel.js';

test('normalizes BSC smart money signal',()=>{
  const [event] = normalizeOkxPush({ arg:{ channel:'dex-market-new-signal-openapi', chainIndex:'56' }, data:[{
    timestamp:'1700000000000', chainIndex:'56', token:{ tokenAddress:'0xABC', symbol:'AKE', holders:'1200', top10HolderPercentage:'42.5' },
    walletType:'1,3', triggerWalletCount:'3', triggerWalletAddress:'0x1,0x2,0x3', amountUsd:'65000', soldRatioPercentage:'8.2', price:'0.01'
  }] });
  assert.equal(event.kind,'smart-signal');
  assert.equal(event.address,'0xabc');
  assert.equal(event.amountUsd,65000);
  assert.equal(event.walletCount,3);
  assert.equal(event.top10Percent,42.5);
});

test('normalizes smart money tracker trade',()=>{
  const [event] = normalizeOkxPush({ arg:{ channel:'kol_smartmoney-tracker-activity' }, data:[{
    chainIndex:'56', tokenContractAddress:'0xDEF', walletAddress:'0xAAA', tokenSymbol:'TEST', quoteTokenSymbol:'USDT',
    quoteTokenAmount:'25000', tradeType:'2', tradeTime:'1700000000001', trackerType:[1], txHash:'0xhash'
  }] });
  assert.equal(event.kind,'smart-trade');
  assert.equal(event.direction,'sell');
  assert.equal(event.quoteAmount,25000);
  assert.deepEqual(event.walletTypes,[1]);
});

test('normalizes large swap event',()=>{
  const [event] = normalizeOkxPush({ arg:{ channel:'trades', chainIndex:'56', tokenContractAddress:'0xABC' }, data:[{
    id:'trade-1', type:'buy', volume:'125000.5', price:'0.25', time:'1700000000002', userAddress:'0x123', dexName:'PancakeSwap'
  }] });
  assert.equal(event.kind,'swap');
  assert.equal(event.amountUsd,125000.5);
  assert.equal(event.direction,'buy');
  assert.equal(event.dexName,'PancakeSwap');
});

test('normalizes liquidity and holder metrics',()=>{
  const [event] = normalizeOkxPush({ arg:{ channel:'price-info', chainIndex:'56', tokenContractAddress:'0xABC' }, data:[{
    time:'1700000000003', liquidity:'550000', holders:'9876', volume5M:'75000', txs5M:'420', priceChange5M:'3.2'
  }] });
  assert.equal(event.kind,'token-metrics');
  assert.equal(event.liquidity,550000);
  assert.equal(event.holders,9876);
  assert.equal(event.txs5m,420);
});
