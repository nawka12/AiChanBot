const DEFAULT_MODELS = {
  BIGGER_MODEL: process.env.OPENROUTER_MODEL_BIGGER || process.env.OPENROUTER_MODEL_HYBRID || 'openai/gpt-5-mini',
  SMALLER_MODEL: process.env.OPENROUTER_MODEL_SMALLER || 'openai/gpt-5-nano',
  MODEL_SMALLER_THINKING: String(process.env.MODEL_SMALLER_THINKING).toLowerCase() === 'true',
  MODEL_BIGGER_THINKING: String(process.env.MODEL_BIGGER_THINKING).toLowerCase() === 'true',
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
};

function getModels() {
  return {
    BIGGER_MODEL: DEFAULT_MODELS.BIGGER_MODEL,
    SMALLER_MODEL: DEFAULT_MODELS.SMALLER_MODEL,
    MODEL_SMALLER_THINKING: DEFAULT_MODELS.MODEL_SMALLER_THINKING,
    MODEL_BIGGER_THINKING: DEFAULT_MODELS.MODEL_BIGGER_THINKING,
  };
}

function getModelCosts() {
  return {
    [DEFAULT_MODELS.BIGGER_MODEL]: { 
      input: process.env.MODEL_BIGGER_COST_IN ? parseFloat(process.env.MODEL_BIGGER_COST_IN) : 0.25, 
      output: process.env.MODEL_BIGGER_COST_OUT ? parseFloat(process.env.MODEL_BIGGER_COST_OUT) : 2.0 
    },
    [DEFAULT_MODELS.SMALLER_MODEL]: { 
      input: process.env.MODEL_SMALLER_COST_IN ? parseFloat(process.env.MODEL_SMALLER_COST_IN) : 0.05, 
      output: process.env.MODEL_SMALLER_COST_OUT ? parseFloat(process.env.MODEL_SMALLER_COST_OUT) : 0.4 
    },
  };
}

module.exports = {
  getModels,
  getModelCosts,
};


