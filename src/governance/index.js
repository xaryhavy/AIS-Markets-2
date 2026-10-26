const prefs = require("./prefs");
const shadowTracker = require("./shadowTracker");
const guardrails = require("./guardrails");

// All trading safety rules (owner switch, live approval, recovery fence, loss caps) are checked here.
async function allowTrade(environment = "demo") {
  return guardrails.allowTrade(environment);
}

async function startup() {
  console.log("AIS Markets: trading starts ON — owner can disable; owner-controlled demo/live execution");
}

module.exports = {
  prefs,
  shadowTracker,
  guardrails,
  allowTrade,
  startup
};
