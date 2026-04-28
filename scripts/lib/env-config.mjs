export const HAGICODE_ENV_KEY_PATTERN = /^HAGICODE_[A-Z0-9_]+$/;
export const STEAM_MODE_ENV_KEY = 'HAGICODE_MODE';
export const STEAM_MODE_ENV_VALUE = 'steam';
export const DEFAULT_STEAM_ENV_CONFIG = Object.freeze({
  [STEAM_MODE_ENV_KEY]: STEAM_MODE_ENV_VALUE
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseEnvConfigInput(value, { label = 'envConfig' } = {}) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (!isPlainObject(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
      }

      return parsed;
    } catch (error) {
      if (error.message === `${label} must be a JSON object.`) {
        throw error;
      }

      throw new Error(`${label} must be a valid JSON object string. ${error.message}`);
    }
  }

  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

export function validateEnvConfig(input, { label = 'envConfig' } = {}) {
  const parsed = parseEnvConfigInput(input, { label }) ?? {};
  const validated = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!HAGICODE_ENV_KEY_PATTERN.test(key)) {
      throw new Error(`${label}.${key} must use an uppercase HAGICODE_* key.`);
    }

    if (typeof value !== 'string') {
      throw new Error(`${label}.${key} must be a string.`);
    }

    if (/[\r\n\0]/u.test(value)) {
      throw new Error(`${label}.${key} must be a single-line string without NUL bytes.`);
    }

    validated[key] = value;
  }

  return validated;
}

export function normalizeSteamEnvConfig(input, { label = 'envConfig' } = {}) {
  const validated = validateEnvConfig(input, { label });
  const normalized = {
    ...DEFAULT_STEAM_ENV_CONFIG
  };

  for (const [key, value] of Object.entries(validated)) {
    if (key === STEAM_MODE_ENV_KEY) {
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function serializeEnvValue(value) {
  if (value === '') {
    return '""';
  }

  if (!/\s/u.test(value) && !value.includes('"') && !value.includes('\\')) {
    return value;
  }

  return JSON.stringify(value);
}

export function serializeEnvConfig(input, { label = 'envConfig' } = {}) {
  const normalized = normalizeSteamEnvConfig(input, { label });
  return Object.entries(normalized)
    .map(([key, value]) => `${key}=${serializeEnvValue(value)}`)
    .join('\n');
}
