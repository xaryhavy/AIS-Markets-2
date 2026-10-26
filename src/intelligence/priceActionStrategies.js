// Price Action Strategies from The Candlestick Trading Bible
// Each strategy: detect pattern → require confluence → output signal
const patterns = require('./candlestickPatterns');
const confluence = require('./confluenceEngine');

const MIN_CONFLUENCE = 40; // Bible: 1-2 factors minimum = ~40 score

const strategies = {
  pinBarConfluence: {
    name: 'Pin Bar + Confluence',
    description: 'Trade pin bars only when aligned with trend + at least one other factor (S/R, EMA, Fib, trendline)',
    generate(history) {
      const detected = patterns.detectAll(history);
      const pin = detected.find(p => p.pattern.includes('Pin Bar'));
      if (!pin) return { action: 'HOLD', reason: 'No pin bar formed', score: 0, strategy: this.name };
      const conf = confluence.scoreConfluence(history, pin.direction, pin.strength);
      if (conf.score < MIN_CONFLUENCE) {
        return { action: 'HOLD', reason: `${pin.pattern} but confluence too low (${conf.score}/100: ${conf.factors.length} factors)`, score: 0, strategy: this.name, confluence: conf };
      }
      return {
        action: pin.direction === 'BULLISH' ? 'BUY' : 'SELL',
        reason: `${pin.pattern} — Grade ${conf.grade} confluence (${conf.score}/100): ${conf.factors.join(', ')}`,
        score: conf.score,
        strategy: this.name,
        pattern: pin.pattern,
        confluence: conf
      };
    }
  },

  engulfingConfluence: {
    name: 'Engulfing Bar + Confluence',
    description: 'Trade engulfing bars with trend, S/R, moving averages, or Fibonacci',
    generate(history) {
      const detected = patterns.detectAll(history);
      const eng = detected.find(p => p.pattern.includes('Engulfing'));
      if (!eng) return { action: 'HOLD', reason: 'No engulfing bar formed', score: 0, strategy: this.name };
      const conf = confluence.scoreConfluence(history, eng.direction, eng.strength);
      if (conf.score < MIN_CONFLUENCE) {
        return { action: 'HOLD', reason: `${eng.pattern} but confluence too low (${conf.score}/100)`, score: 0, strategy: this.name, confluence: conf };
      }
      return {
        action: eng.direction === 'BULLISH' ? 'BUY' : 'SELL',
        reason: `${eng.pattern} — Grade ${conf.grade} confluence (${conf.score}/100): ${conf.factors.join(', ')}`,
        score: conf.score,
        strategy: this.name,
        pattern: eng.pattern,
        confluence: conf
      };
    }
  },

  insideBarBreakout: {
    name: 'Inside Bar Breakout + Confluence',
    description: 'Trade inside bar breakouts from key levels with trend alignment',
    generate(history) {
      const detected = patterns.detectAll(history);
      const ib = detected.find(p => p.pattern === 'Inside Bar False Breakout');
      if (!ib) return { action: 'HOLD', reason: 'No inside bar false breakout', score: 0, strategy: this.name };
      const conf = confluence.scoreConfluence(history, ib.direction, ib.strength);
      if (conf.score < MIN_CONFLUENCE) {
        return { action: 'HOLD', reason: `Inside bar false breakout but confluence too low (${conf.score}/100)`, score: 0, strategy: this.name, confluence: conf };
      }
      return {
        action: ib.direction === 'BULLISH' ? 'BUY' : 'SELL',
        reason: `Inside Bar False Breakout — Grade ${conf.grade} confluence (${conf.score}/100): ${conf.factors.join(', ')}`,
        score: conf.score,
        strategy: this.name,
        pattern: 'Inside Bar False Breakout',
        confluence: conf
      };
    }
  },

  reversalStarPatterns: {
    name: 'Star Reversal Patterns (Morning/Evening Star)',
    description: '3-candle reversal patterns at key S/R with trend exhaustion',
    generate(history) {
      const detected = patterns.detectAll(history);
      const star = detected.find(p => p.pattern.includes('Star'));
      if (!star) return { action: 'HOLD', reason: 'No star pattern formed', score: 0, strategy: this.name };
      const conf = confluence.scoreConfluence(history, star.direction, star.strength);
      if (conf.score < MIN_CONFLUENCE) {
        return { action: 'HOLD', reason: `${star.pattern} but confluence too low (${conf.score}/100)`, score: 0, strategy: this.name, confluence: conf };
      }
      return {
        action: star.direction === 'BULLISH' ? 'BUY' : 'SELL',
        reason: `${star.pattern} — Grade ${conf.grade} confluence (${conf.score}/100): ${conf.factors.join(', ')}`,
        score: conf.score,
        strategy: this.name,
        pattern: star.pattern,
        confluence: conf
      };
    }
  }
};

function listStrategies() { return Object.keys(strategies); }
function getStrategy(name) { return strategies[name]; }

module.exports = { strategies, listStrategies, getStrategy, MIN_CONFLUENCE };