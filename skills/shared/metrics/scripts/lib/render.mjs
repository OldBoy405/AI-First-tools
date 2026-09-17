// FR-8 人读摘要渲染（CR-2026-069 TASK-01，SDD §3.6 输出纪律①）。
//
// 同一对象渲染，**不写第二份产物文件**；只做格式化，不做计算。

const fmt = (n) => (typeof n === 'number' ? String(n) : String(n === null ? 'null' : n));

export function renderSummary(report) {
  const lines = [];
  lines.push('cr-cost report  window=' + fmt(report.window) + '  observedAt=' + fmt(report.observedAt));
  lines.push('  sampleCRs=' + fmt(report.sampleCRs) + '  coverage=' + JSON.stringify(report.coverage));
  lines.push('  tokenEstimator=' + fmt(report.tokenEstimator) + '  costSource=' + fmt(report.costSource) + '  k=' + fmt(report.k));
  lines.push('  providerUsage=' + JSON.stringify(report.providerUsage));
  lines.push('  toolResultTokens=' + fmt(report.toolResultTokens));
  const m = report.metrics || {};
  lines.push('  metrics: tokensPerCR=' + fmt(m.tokensPerCR) + ' sessionsPerCR=' + fmt(m.sessionsPerCR) +
    ' searchTokenRatio=' + fmt(m.searchTokenRatio) + ' fullReadRatio=' + fmt(m.fullReadRatio) +
    ' bootstrapTokensPerSession=' + fmt(m.bootstrapTokensPerSession));
  const g = report.guardrails || {};
  lines.push('  guardrails: firstPassGateRate=' + fmt(g.firstPassGateRate) +
    ' reviewLoopsPerCR=' + fmt(g.reviewLoopsPerCR) + ' reviewDefectsPerCR=' + fmt(g.reviewDefectsPerCR));
  lines.push('  crctlCommands(' + String((report.crctlCommands || []).length) + '):');
  for (const row of report.crctlCommands || []) {
    lines.push('    ' + row.command + '  tokens=' + fmt(row.tokens) + '  calls=' + fmt(row.calls));
  }
  if (report.counters) lines.push('  counters=' + JSON.stringify(report.counters));
  lines.push('  rule=' + fmt(report.rule));
  return lines.join('\n');
}

export function renderAfter(verdict) {
  const lines = ['cr-cost after verdict=' + fmt(verdict.status)];
  lines.push('  reason=' + fmt(verdict.reason));
  for (const c of verdict.checks || []) {
    lines.push('  [' + (c.ok ? 'ok' : 'not-ok') + '] ' + c.id + ' = ' + fmt(c.detail));
  }
  return lines.join('\n');
}
