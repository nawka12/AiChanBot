// Centralized model configuration and selection

const DEFAULT_MODELS = {
  BIGGER_MODEL: process.env.OPENROUTER_MODEL_BIGGER || 'openai/gpt-5-mini',
  SMALLER_MODEL: process.env.OPENROUTER_MODEL_SMALLER || 'openai/gpt-5-nano',
  COMPLEXITY_MODEL: process.env.OPENROUTER_MODEL_COMPLEXITY || process.env.OPENROUTER_MODEL_SMALLER || 'openai/gpt-4.1-nano',
};

const MODEL_COSTS = {
  [DEFAULT_MODELS.BIGGER_MODEL]: { 
    input: process.env.MODEL_BIGGER_COST_IN ? parseFloat(process.env.MODEL_BIGGER_COST_IN) : 0.25, 
    output: process.env.MODEL_BIGGER_COST_OUT ? parseFloat(process.env.MODEL_BIGGER_COST_OUT) : 2.0 
  },
  [DEFAULT_MODELS.SMALLER_MODEL]: { 
    input: process.env.MODEL_SMALLER_COST_IN ? parseFloat(process.env.MODEL_SMALLER_COST_IN) : 0.05, 
    output: process.env.MODEL_SMALLER_COST_OUT ? parseFloat(process.env.MODEL_SMALLER_COST_OUT) : 0.4 
  },
  [DEFAULT_MODELS.COMPLEXITY_MODEL]: { 
    input: process.env.MODEL_COMPLEXITY_IN ? parseFloat(process.env.MODEL_COMPLEXITY_IN) : 0.10, 
    output: process.env.MODEL_COMPLEXITY_OUT ? parseFloat(process.env.MODEL_COMPLEXITY_OUT) : 0.4 
  },
};

function getModels() {
  return {
    BIGGER_MODEL: DEFAULT_MODELS.BIGGER_MODEL,
    SMALLER_MODEL: DEFAULT_MODELS.SMALLER_MODEL,
    COMPLEXITY_MODEL: DEFAULT_MODELS.COMPLEXITY_MODEL,
  };
}

function getModelCosts() {
  // Rebuild costs from current environment variables to handle runtime changes
  return {
    [DEFAULT_MODELS.BIGGER_MODEL]: { 
      input: process.env.MODEL_BIGGER_COST_IN ? parseFloat(process.env.MODEL_BIGGER_COST_IN) : 0.25, 
      output: process.env.MODEL_BIGGER_COST_OUT ? parseFloat(process.env.MODEL_BIGGER_COST_OUT) : 2.0 
    },
    [DEFAULT_MODELS.SMALLER_MODEL]: { 
      input: process.env.MODEL_SMALLER_COST_IN ? parseFloat(process.env.MODEL_SMALLER_COST_IN) : 0.05, 
      output: process.env.MODEL_SMALLER_COST_OUT ? parseFloat(process.env.MODEL_SMALLER_COST_OUT) : 0.4 
    },
    [DEFAULT_MODELS.COMPLEXITY_MODEL]: { 
      input: process.env.MODEL_COMPLEXITY_IN ? parseFloat(process.env.MODEL_COMPLEXITY_IN) : 0.10, 
      output: process.env.MODEL_COMPLEXITY_OUT ? parseFloat(process.env.MODEL_COMPLEXITY_OUT) : 0.4 
    },
  };
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


