// The built-in strategies as registry descriptors. Kept out of registry.js so the registry stays a record
// store and never has to know what a strategy is.
const { strategies, listStrategies } = require('../intelligence/strategies');
const registry = require('./registry');

// What the hash covers. `source` is the strategy's own generate() text, so a code change produces a new
// version and needs a new approval — not just a change to its declared parameters.
function descriptors() {
  return listStrategies().map((name) => {
    const strat = strategies[name];
    return {
      strategy: name,
      rules: {
        name: strat.name,
        params: strat.defaultParams || {},
        source: typeof strat.generate === 'function' ? strat.generate.toString() : null
      }
    };
  });
}

// Registers every built-in and adopts them on first run. Returns what was created and what is runnable,
// so a caller can report the difference between "new version waiting for approval" and "nothing changed".
//
// Adoption runs first, and that order matters: it only adopts strategies that have no version yet. Registering
// first would create a DRAFT for each one and leave the migration with nothing to adopt — a first run that
// silently deploys nothing.
async function ensure() {
  const adoption = await registry.adoptBaseline(descriptors());
  const registered = [];
  for (const descriptor of descriptors()) {
    const { record, created } = await registry.register(descriptor.strategy, descriptor.rules, {
      actor: 'engine',
      reason: 'built-in strategy registered from src/intelligence/strategies.js'
    });
    if (created) registered.push(record);
  }
  return { registered, adopted: adoption.records, runnable: await registry.runnableNames() };
}

module.exports = { descriptors, ensure };
