// Centralized model configuration and selection

const DEFAULT_MODELS = {
  BIGGER_MODEL: process.env.OPENROUTER_MODEL_BIGGER || 'anthropic/claude-sonnet-4',
  SMALLER_MODEL: process.env.OPENROUTER_MODEL_SMALLER || 'anthropic/claude-3.5-haiku',
};

const MODEL_COSTS = {
  [DEFAULT_MODELS.BIGGER_MODEL]: { input: 0.25, output: 2.0 },
  [DEFAULT_MODELS.SMALLER_MODEL]: { input: 0.05, output: 0.4 },
};

function getModels() {
  return {
    BIGGER_MODEL: DEFAULT_MODELS.BIGGER_MODEL,
    SMALLER_MODEL: DEFAULT_MODELS.SMALLER_MODEL,
  };
}

function getModelCosts() {
  return MODEL_COSTS;
}

function selectModelByComplexity(complexity) {
  const { BIGGER_MODEL, SMALLER_MODEL } = getModels();
  switch ((complexity || 'simple').toLowerCase()) {
    case 'complex':
    case 'very_complex':
      return BIGGER_MODEL;
    default:
      return SMALLER_MODEL;
  }
}

module.exports = {
  getModels,
  getModelCosts,
  selectModelByComplexity,
};


