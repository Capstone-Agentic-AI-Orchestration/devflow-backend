import { validateEnv } from './env.validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid env — contains all REQUIRED fields plus key optional fields.
 * All tests start from this baseline and override individual fields.
 */
function validEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/devflow_test',
    SUPABASE_URL: 'https://abc.supabase.co',
    ALLOWED_ORIGINS: 'http://localhost:3001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  // ── required fields ────────────────────────────────────────────────────────

  describe('DATABASE_URL', () => {
    it('throws when DATABASE_URL is missing', () => {
      const env = validEnv();
      delete env['DATABASE_URL'];
      expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
    });

    it('throws when DATABASE_URL is not a valid URL', () => {
      expect(() => validateEnv(validEnv({ DATABASE_URL: 'not-a-url' }))).toThrow(
        /DATABASE_URL/,
      );
    });

    it('accepts a valid postgresql:// DATABASE_URL', () => {
      const result = validateEnv(validEnv());
      expect(result.DATABASE_URL).toBe(
        'postgresql://user:pass@localhost:5432/devflow_test',
      );
    });
  });

  describe('SUPABASE_URL', () => {
    it('throws when SUPABASE_URL is missing', () => {
      const env = validEnv();
      delete env['SUPABASE_URL'];
      expect(() => validateEnv(env)).toThrow(/SUPABASE_URL/);
    });

    it('throws when SUPABASE_URL is not a valid URL', () => {
      expect(() => validateEnv(validEnv({ SUPABASE_URL: 'not-a-url' }))).toThrow(
        /SUPABASE_URL/,
      );
    });

    it('accepts a valid https:// SUPABASE_URL', () => {
      const result = validateEnv(validEnv());
      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
    });
  });

  describe('ALLOWED_ORIGINS', () => {
    it('throws when ALLOWED_ORIGINS is missing', () => {
      const env = validEnv();
      delete env['ALLOWED_ORIGINS'];
      expect(() => validateEnv(env)).toThrow(/ALLOWED_ORIGINS/);
    });

    it('accepts a valid ALLOWED_ORIGINS string', () => {
      const result = validateEnv(validEnv());
      expect(result.ALLOWED_ORIGINS).toBe('http://localhost:3001');
    });

    it('accepts multiple comma-separated origins', () => {
      const result = validateEnv(
        validEnv({
          ALLOWED_ORIGINS:
            'http://localhost:3001,https://app.devflow.com',
        }),
      );
      expect(result.ALLOWED_ORIGINS).toContain('localhost');
    });
  });

  // ── optional fields with defaults ──────────────────────────────────────────

  describe('PORT', () => {
    it('defaults to 3000 when PORT is not provided', () => {
      const result = validateEnv(validEnv());
      expect(result.PORT).toBe(3000);
    });

    it('parses PORT from string to number', () => {
      const result = validateEnv(validEnv({ PORT: '4000' }));
      expect(result.PORT).toBe(4000);
    });

    it('throws when PORT is zero (not positive)', () => {
      expect(() => validateEnv(validEnv({ PORT: '0' }))).toThrow();
    });

    it('throws when PORT is not numeric', () => {
      expect(() => validateEnv(validEnv({ PORT: 'abc' }))).toThrow();
    });
  });

  describe('NODE_ENV', () => {
    it('defaults to "development" when NODE_ENV is not provided', () => {
      const result = validateEnv(validEnv());
      expect(result.NODE_ENV).toBe('development');
    });

    it('accepts "production"', () => {
      const result = validateEnv(validEnv({ NODE_ENV: 'production' }));
      expect(result.NODE_ENV).toBe('production');
    });

    it('accepts "test"', () => {
      const result = validateEnv(validEnv({ NODE_ENV: 'test' }));
      expect(result.NODE_ENV).toBe('test');
    });

    it('throws for an invalid NODE_ENV value', () => {
      expect(() => validateEnv(validEnv({ NODE_ENV: 'staging' }))).toThrow(
        /NODE_ENV/,
      );
    });
  });

  describe('AGENT_PROVIDER', () => {
    it('defaults to "mock" when AGENT_PROVIDER is not provided', () => {
      const result = validateEnv(validEnv());
      expect(result.AGENT_PROVIDER).toBe('mock');
    });

    it('accepts "llm"', () => {
      const result = validateEnv(validEnv({ AGENT_PROVIDER: 'llm' }));
      expect(result.AGENT_PROVIDER).toBe('llm');
    });

    it('throws for an invalid AGENT_PROVIDER value', () => {
      expect(() =>
        validateEnv(validEnv({ AGENT_PROVIDER: 'openai' })),
      ).toThrow(/AGENT_PROVIDER/);
    });
  });

  describe('ENABLE_SWAGGER', () => {
    it('defaults to "false" when not provided', () => {
      const result = validateEnv(validEnv());
      expect(result.ENABLE_SWAGGER).toBe('false');
    });

    it('accepts "true"', () => {
      const result = validateEnv(validEnv({ ENABLE_SWAGGER: 'true' }));
      expect(result.ENABLE_SWAGGER).toBe('true');
    });
  });

  describe('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY', () => {
    it('defaults SUPABASE_ANON_KEY to empty string', () => {
      const result = validateEnv(validEnv());
      expect(result.SUPABASE_ANON_KEY).toBe('');
    });

    it('defaults SUPABASE_SERVICE_ROLE_KEY to empty string', () => {
      const result = validateEnv(validEnv());
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('');
    });

    it('accepts provided SUPABASE_ANON_KEY', () => {
      const result = validateEnv(validEnv({ SUPABASE_ANON_KEY: 'anon-key-value' }));
      expect(result.SUPABASE_ANON_KEY).toBe('anon-key-value');
    });
  });

  // ── optional agent/LLM fields ──────────────────────────────────────────────

  describe('LLM configuration defaults', () => {
    it('defaults LLM_PROVIDER to "openrouter"', () => {
      const result = validateEnv(validEnv());
      expect(result.LLM_PROVIDER).toBe('openrouter');
    });

    it('defaults LLM_REQUEST_TIMEOUT_MS to 120000', () => {
      const result = validateEnv(validEnv());
      expect(result.LLM_REQUEST_TIMEOUT_MS).toBe(120000);
    });

    it('defaults LLM_CONCURRENCY_LIMIT to 4', () => {
      const result = validateEnv(validEnv());
      expect(result.LLM_CONCURRENCY_LIMIT).toBe(4);
    });
  });

  // ── happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns a fully typed config for a minimal valid env', () => {
      const result = validateEnv(validEnv());

      expect(result.DATABASE_URL).toBe(
        'postgresql://user:pass@localhost:5432/devflow_test',
      );
      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
      expect(result.ALLOWED_ORIGINS).toBe('http://localhost:3001');
      expect(result.NODE_ENV).toBe('development');
      expect(result.PORT).toBe(3000);
      expect(result.AGENT_PROVIDER).toBe('mock');
    });

    it('does not throw for a minimal valid env', () => {
      expect(() => validateEnv(validEnv())).not.toThrow();
    });

    it('does not throw when optional fields are provided', () => {
      expect(() =>
        validateEnv(
          validEnv({
            NODE_ENV: 'test',
            PORT: '4000',
            AGENT_PROVIDER: 'mock',
            ENABLE_SWAGGER: 'false',
            SUPABASE_ANON_KEY: 'anon-key',
            SUPABASE_SERVICE_ROLE_KEY: 'service-key',
          }),
        ),
      ).not.toThrow();
    });

    it('accepts LLM_PROVIDER "anthropic"', () => {
      const result = validateEnv(validEnv({ LLM_PROVIDER: 'anthropic' }));
      expect(result.LLM_PROVIDER).toBe('anthropic');
    });

    it('parses LLM_REQUEST_TIMEOUT_MS from string', () => {
      const result = validateEnv(
        validEnv({ LLM_REQUEST_TIMEOUT_MS: '60000' }),
      );
      expect(result.LLM_REQUEST_TIMEOUT_MS).toBe(60000);
    });
  });

  // ── error message quality ──────────────────────────────────────────────────

  describe('error message quality', () => {
    it('includes the failing field name in the error message', () => {
      const env = validEnv();
      delete env['DATABASE_URL'];
      let errorMessage = '';
      try {
        validateEnv(env);
      } catch (e) {
        errorMessage = (e as Error).message;
      }
      expect(errorMessage).toContain('DATABASE_URL');
    });

    it('throws an Error instance (not a plain string)', () => {
      const env = validEnv();
      delete env['DATABASE_URL'];
      expect(() => validateEnv(env)).toThrow(Error);
    });
  });
});
