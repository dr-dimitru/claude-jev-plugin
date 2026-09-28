import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  askJev,
  askTypeSafe,
  isRetryableStatus,
  registerApiKey,
  clearRegisteredApiKeys,
  redact,
  JevError,
  TypeSafeError,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  parseRetryAfter,
  validateJevResponse,
  validateTypeSafeResponse,
  type JevCall,
  type JevQuestion,
  type JevResponse,
  type TypeSafeAnswer,
  type TypeSafeCall,
  type TypeSafeChoiceAnswer,
  type TypeSafeChoiceQuestion,
  type TypeSafeNoulAnswer,
  type TypeSafeNoulQuestion,
  type TypeSafeQuestion,
  type TypeSafeResponse,
  type TypeSafeScoreAnswer,
  type TypeSafeScoreQuestion,
  type TypeSafeUsage,
} from "../src/client.ts";

describe("TypeSafe Jev Client", () => {
  const originalEnvKey = process.env.TYPESAFE_API_KEY;

  beforeEach(() => {
    clearRegisteredApiKeys();
    delete process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    clearRegisteredApiKeys();
    if (originalEnvKey !== undefined) {
      process.env.TYPESAFE_API_KEY = originalEnvKey;
    } else {
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  describe("Constants and defaults", () => {
    it("exports default constants", () => {
      assert.equal(DEFAULT_MODEL, "jev-latest");
      assert.equal(DEFAULT_TYPESAFE_MODEL, DEFAULT_MODEL);
      assert.equal(DEFAULT_ENDPOINT, "https://api.typesafe.ai/v1/systemone");
      assert.equal(DEFAULT_TIMEOUT_MS, 15000);
      assert.equal(DEFAULT_RETRIES, 2);
    });

    it("exports model-neutral names and preserves Jev aliases", () => {
      const noulQuestion: TypeSafeNoulQuestion = {
        type: "noul",
        instructions: "Does this fit?",
      };
      const scoreQuestion: TypeSafeScoreQuestion = {
        type: "score",
        instructions: "How well does this fit?",
        criteria: ["poor", "strong"],
      };
      const choiceQuestion: TypeSafeChoiceQuestion = {
        type: "choice",
        instructions: "Which option fits?",
        criteria: { first: "First", second: "Second" },
      };
      const question: TypeSafeQuestion = noulQuestion;
      const call: TypeSafeCall = { state: {}, questions: { q: question } };
      const answers: Record<string, TypeSafeAnswer> = {
        noul: { type: "noul", noul: 0.5 } satisfies TypeSafeNoulAnswer,
        choice: {
          type: "choice",
          choice: "first",
          probabilities: { first: 1 },
          confidence: 1,
        } satisfies TypeSafeChoiceAnswer,
        score: {
          type: "score",
          score: 0,
          legend: { "0": "poor", "1": "strong" },
          probabilities: { "0": 1, "1": 0 },
          confidence: 1,
        } satisfies TypeSafeScoreAnswer,
      };
      const usage: TypeSafeUsage = { input_tokens: 1, output_tokens: 0 };
      const response: TypeSafeResponse = { model: "jev-latest", answers, usage };

      assert.equal(askJev, askTypeSafe);
      assert.equal(JevError, TypeSafeError);
      assert.equal(validateJevResponse, validateTypeSafeResponse);
      assert.equal(call.questions.q.type, "noul");
      assert.equal(scoreQuestion.criteria.length, 2);
      assert.equal(choiceQuestion.criteria.first, "First");
      assert.equal(response.model, "jev-latest");
    });
  });

  describe("Request format and headers", () => {
    it("posts to default endpoint with Bearer auth and exact request body", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              destructive: { type: "noul", noul: 0.12 },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const questions: Record<string, JevQuestion> = {
        destructive: {
          type: "noul",
          instructions: "Is this action destructive?",
          criteria: { true: "Deletes data", false: "Does not delete" },
        },
      };

      const state = { cwd: "/test/project", tool: "Bash", tool_input: { command: "ls" } };

      const response = await askJev({
        apiKey: "ts-test-secret-key-12345",
        state,
        questions,
        fetch: mockFetch,
      });

      assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
      assert.equal(capturedInit?.method, "POST");

      const headers = new Headers(capturedInit?.headers);
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(headers.get("Authorization"), "Bearer ts-test-secret-key-12345");

      const parsedBody = JSON.parse(String(capturedInit?.body));
      assert.deepEqual(parsedBody, {
        model: "jev-latest",
        state,
        questions,
      });

      assert.equal(response.model, "jev-latest");
      assert.equal(response.answers.destructive.noul, 0.12);
    });

    it("supports custom endpoint and custom model", async () => {
      let capturedUrl = "";
      let capturedModel = "";

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        const body = JSON.parse(String(init?.body));
        capturedModel = body.model;
        return new Response(
          JSON.stringify({
            model: "jev-custom-preview",
            answers: {
              q1: { type: "noul", noul: 0.05 },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      await askJev({
        apiKey: "ts-key",
        endpoint: "https://custom.endpoint.ai/v1/systemone",
        model: "jev-custom-preview",
        state: {},
        questions: { q1: { type: "noul", instructions: "test" } },
        fetch: mockFetch,
      });

      assert.equal(capturedUrl, "https://custom.endpoint.ai/v1/systemone");
      assert.equal(capturedModel, "jev-custom-preview");
    });

    it("sends a configured model ID unchanged through askTypeSafe", async () => {
      let capturedModel = "";
      const model = "provider/custom-model-v2";

      const mockFetch: typeof fetch = async (_input, init) => {
        capturedModel = JSON.parse(String(init?.body)).model;
        return new Response(
          JSON.stringify({
            model,
            answers: { q1: { type: "noul", noul: 0.5 } },
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
          { status: 200 }
        );
      };

      await askTypeSafe({
        apiKey: "test-key",
        model,
        state: {},
        questions: { q1: { type: "noul", instructions: "test" } },
        fetch: mockFetch,
      });

      assert.equal(capturedModel, model);
    });

    it("rejects non-HTTPS endpoints before fetch", async () => {
      let fetched = false;

      await assert.rejects(
        askJev({
          apiKey: "test-key",
          endpoint: "http://attacker.example/collect",
          state: {},
          questions: { q: { type: "noul", instructions: "Is it true?" } },
          fetch: async () => {
            fetched = true;
            throw new Error("must not run");
          },
        }),
        (error: unknown) =>
          error instanceof JevError && error.code === "INVALID_ENDPOINT"
      );

      assert.equal(fetched, false);
    });

    it("rejects endpoints containing embedded credentials", async () => {
      await assert.rejects(
        askJev({
          apiKey: "test-key",
          endpoint: "https://user:password@api.typesafe.ai/v1/systemone",
          state: {},
          questions: { q: { type: "noul", instructions: "Is it true?" } },
        }),
        (error: unknown) =>
          error instanceof JevError && error.code === "INVALID_ENDPOINT"
      );
    });

    it("reads apiKey from process.env.TYPESAFE_API_KEY when call.apiKey is omitted", async () => {
      process.env.TYPESAFE_API_KEY = "env-secret-key-abc";
      let authHeader = "";

      const mockFetch: typeof fetch = async (_input, init) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get("Authorization") ?? "";
        return new Response(
          JSON.stringify({ model: "jev-latest", answers: { q1: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 }
        );
      };

      await askJev({
        state: {},
        questions: { q1: { type: "noul", instructions: "test" } },
        fetch: mockFetch,
      });

      assert.equal(authHeader, "Bearer env-secret-key-abc");
    });

    it("throws JevError when no apiKey is provided in call or env", async () => {
      delete process.env.TYPESAFE_API_KEY;

      await assert.rejects(
        async () => {
          await askJev({
            state: {},
            questions: {},
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MISSING_KEY");
          assert.equal(err.retryable, false);
          assert.match(err.message, /missing/i);
          return true;
        }
      );
    });
  });

  describe("Retry classification and handling", () => {
    it("isRetryableStatus classifies 429, 529, and 5xx correctly", () => {
      assert.equal(isRetryableStatus(429), true);
      assert.equal(isRetryableStatus(529), true);
      assert.equal(isRetryableStatus(500), true);
      assert.equal(isRetryableStatus(502), true);
      assert.equal(isRetryableStatus(503), true);
      assert.equal(isRetryableStatus(504), true);

      assert.equal(isRetryableStatus(200), false);
      assert.equal(isRetryableStatus(201), false);
      assert.equal(isRetryableStatus(400), false);
      assert.equal(isRetryableStatus(401), false);
      assert.equal(isRetryableStatus(403), false);
      assert.equal(isRetryableStatus(404), false);
      assert.equal(isRetryableStatus(422), false);
    });

    it("retries on HTTP 429 and succeeds on subsequent attempt", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response(
          JSON.stringify({ model: "jev-latest", answers: { q1: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 }
        );
      };

      const res = await askJev({
        apiKey: "test-key",
        state: {},
        questions: { q1: { type: "noul", instructions: "q" } },
        retryDelayMs: 1,
        fetch: mockFetch,
      });

      assert.equal(callCount, 2);
      assert.equal(res.answers.q1.noul, 0.2);
    });

    it("retries on HTTP 529 and succeeds on subsequent attempt", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Site Overloaded", { status: 529 });
        }
        return new Response(
          JSON.stringify({ model: "jev-latest", answers: { q1: { type: "noul", noul: 0.3 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 }
        );
      };

      const res = await askJev({
        apiKey: "test-key",
        state: {},
        questions: { q1: { type: "noul", instructions: "q" } },
        retryDelayMs: 1,
        fetch: mockFetch,
      });

      assert.equal(callCount, 2);
      assert.equal(res.answers.q1.noul, 0.3);
    });

    it("retries on HTTP 503 and succeeds on subsequent attempt", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(
          JSON.stringify({ model: "jev-latest", answers: { q1: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 }
        );
      };

      const res = await askJev({
        apiKey: "test-key",
        state: {},
        questions: { q1: { type: "noul", instructions: "q" } },
        retryDelayMs: 1,
        fetch: mockFetch,
      });

      assert.equal(callCount, 2);
      assert.equal(res.answers.q1.noul, 0.4);
    });

    it("retries on network error and succeeds", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          throw new TypeError("fetch failed");
        }
        return new Response(
          JSON.stringify({ model: "jev-latest", answers: { q1: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 }
        );
      };

      const res = await askJev({
        apiKey: "test-key",
        state: {},
        questions: { q1: { type: "noul", instructions: "q" } },
        retryDelayMs: 1,
        fetch: mockFetch,
      });

      assert.equal(callCount, 2);
      assert.equal(res.answers.q1.noul, 0.5);
    });

    it("exhausts retries and throws JevError after 1 initial attempt + 2 retries = 3 attempts total", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return new Response("Internal Server Error", { status: 500 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "noul", instructions: "q" } },
            retries: 2,
            retryDelayMs: 1,
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.status, 500);
          assert.equal(err.retryable, true);
          return true;
        }
      );

      assert.equal(callCount, 3);
    });

    it("does NOT retry on non-retryable 4xx errors (e.g. 400, 401)", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return new Response("Invalid request payload", { status: 400 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            retries: 2,
            retryDelayMs: 1,
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.status, 400);
          assert.equal(err.retryable, false);
          return true;
        }
      );

      assert.equal(callCount, 1);
    });
  });

  describe("Timeout and caller abort behavior", () => {
    it("applies timeout to response body reads", async () => {
      const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true }
            );
            setTimeout(() => reject(new Error("body still pending after deadline")), 100);
          }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        askJev({
          apiKey: "test-key",
          timeoutMs: 40,
          retries: 0,
          state: {},
          questions: { q: { type: "noul", instructions: "Is it true?" } },
          fetch: fetchFn,
        }),
        (error: unknown) => error instanceof JevError && error.code === "TIMEOUT"
      );
    });

    it("uses one total timeout across all retry attempts", async () => {
      let callCount = 0;
      const started = Date.now();
      const fetchFn: typeof fetch = async (_input, init) => {
        callCount++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        });
      };

      await assert.rejects(
        askJev({
          apiKey: "test-key",
          timeoutMs: 60,
          retries: 2,
          retryDelayMs: 0,
          state: {},
          questions: { q: { type: "noul", instructions: "Is it true?" } },
          fetch: fetchFn,
        }),
        (error: unknown) => error instanceof JevError && error.code === "TIMEOUT"
      );

      assert.ok(Date.now() - started < 130);
      assert.ok(callCount <= 2);
    });

    it("does not retry when Retry-After exceeds the remaining deadline", async () => {
      let callCount = 0;
      await assert.rejects(
        askJev({
          apiKey: "test-key",
          timeoutMs: 60,
          retries: 2,
          state: {},
          questions: { q: { type: "noul", instructions: "Is it true?" } },
          fetch: async () => {
            callCount++;
            return new Response("busy", {
              status: 429,
              headers: { "Retry-After": "1" },
            });
          },
        }),
        (error: unknown) => error instanceof JevError && error.code === "TIMEOUT"
      );
      assert.equal(callCount, 1);
    });

    it("parses Retry-After seconds and HTTP dates", () => {
      const now = Date.parse("2026-09-20T12:00:00.000Z");
      assert.equal(parseRetryAfter("2", now), 2000);
      assert.equal(parseRetryAfter("Sun, 20 Sep 2026 12:00:03 GMT", now), 3000);
      assert.equal(parseRetryAfter("invalid", now), undefined);
    });

    it("times out within the total budget and retries up to the retry limit", async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async (_input, init) => {
        callCount++;
        // Simulate hang that listens to attempt signal
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            timeoutMs: 30,
            retries: 1,
            retryDelayMs: 1,
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "TIMEOUT");
          assert.equal(err.retryable, true);
          return true;
        }
      );

      assert.ok(callCount >= 1 && callCount <= 2);
    });

    it("aborts immediately without retrying when caller abort signal fires", async () => {
      const controller = new AbortController();
      let callCount = 0;

      const mockFetch: typeof fetch = async (_input, init) => {
        callCount++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Caller aborted");
            err.name = "AbortError";
            reject(err);
          });
          setTimeout(() => {
            controller.abort(new Error("User cancelled"));
          }, 10);
        });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            signal: controller.signal,
            retries: 3,
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "ABORTED");
          assert.equal(err.retryable, false);
          return true;
        }
      );

      assert.equal(callCount, 1); // No retries for caller abort
    });

    it("rejects immediately if caller signal is already aborted before request starts", async () => {
      const controller = new AbortController();
      controller.abort();
      let callCount = 0;

      const mockFetch: typeof fetch = async () => {
        callCount++;
        return new Response("{}", { status: 200 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            signal: controller.signal,
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "ABORTED");
          return true;
        }
      );

      assert.equal(callCount, 0);
    });
  });

  describe("Response validation", () => {
    const usage = { input_tokens: 1, output_tokens: 1 };

    it("rejects a choice outside declared criteria", () => {
      assert.throws(
        () =>
          validateJevResponse(
            {
              model: "jev-1.13.0",
              answers: {
                q: {
                  type: "choice",
                  choice: "unknown",
                  probabilities: { allowed: 0.4, unknown: 0.6 },
                  confidence: 0.2,
                },
              },
              usage,
            },
            {
              q: {
                type: "choice",
                instructions: "Choose",
                criteria: { allowed: "Allowed" },
              },
            }
          ),
        (error: unknown) =>
          error instanceof JevError && error.code === "MALFORMED_RESPONSE"
      );
    });

    it("rejects malformed probability maps against declared criteria", () => {
      const question: Record<string, JevQuestion> = {
        q: {
          type: "choice",
          instructions: "Choose",
          criteria: { first: "First", second: "Second" },
        },
      };
      for (const probabilities of [
        {},
        { first: 0.4, second: 0.4 },
        { first: 1, second: 0, extra: 0 },
        { first: 1 },
      ]) {
        assert.throws(
          () =>
            validateJevResponse(
              {
                model: "jev-1.13.0",
                answers: {
                  q: {
                    type: "choice",
                    choice: "first",
                    probabilities,
                    confidence: 1,
                  },
                },
                usage,
              },
              question
            ),
          (error: unknown) =>
            error instanceof JevError && error.code === "MALFORMED_RESPONSE"
        );
      }
    });

    it("accepts a rounded probability map and renormalizes it", () => {
      const question: Record<string, JevQuestion> = {
        q: {
          type: "choice",
          instructions: "Choose",
          criteria: { a: "A", b: "B", c: "C" },
        },
      };
      for (const probabilities of [
        { a: 0.87, b: 0.08, c: 0.04 }, // 0.99, two-decimal rounding
        { a: 0.9, b: 0.08, c: 0.03 }, // 1.01
        { a: 0.5, b: 0.5, c: 0 },
      ]) {
        const res = validateJevResponse(
          {
            model: "jev-1.13.0",
            answers: { q: { type: "choice", choice: "a", probabilities, confidence: 0.9 } },
            usage,
          },
          question
        );
        const answer = res.answers.q as { probabilities: Record<string, number> };
        const total = Object.values(answer.probabilities).reduce((s, v) => s + v, 0);
        assert.ok(Math.abs(total - 1) < 1e-9, `renormalized sum ${total}`);
        assert.equal(Object.keys(answer.probabilities).length, 3);
      }
      assert.throws(
        () =>
          validateJevResponse(
            {
              model: "jev-1.13.0",
              answers: {
                q: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.3, c: 0 }, confidence: 0.9 },
              },
              usage,
            },
            question
          ),
        (error: unknown) => error instanceof JevError && error.code === "MALFORMED_RESPONSE"
      );
    });

    it("rejects score keys, legends, and values outside declared levels", () => {
      const question: Record<string, JevQuestion> = {
        q: { type: "score", instructions: "Rate", criteria: ["Low", "High"] },
      };
      for (const answer of [
        {
          type: "score",
          score: 2,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0, "1": 1 },
          confidence: 1,
        },
        {
          type: "score",
          score: 1,
          legend: { "0": "Wrong", "1": "High" },
          probabilities: { "0": 0, "1": 1 },
          confidence: 1,
        },
        {
          type: "score",
          score: 1,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0, "2": 1 },
          confidence: 1,
        },
      ]) {
        assert.throws(
          () =>
            validateJevResponse(
              { model: "jev-1.13.0", answers: { q: answer }, usage },
              question
            ),
          (error: unknown) =>
            error instanceof JevError && error.code === "MALFORMED_RESPONSE"
        );
      }
    });

    it("rejects missing required top-level model or usage", () => {
      const questions: Record<string, JevQuestion> = {
        q: { type: "noul", instructions: "Is it true?" },
      };
      assert.throws(
        () => validateJevResponse({ answers: { q: { type: "noul", noul: 0.5 } }, usage }, questions),
        (error: unknown) => error instanceof JevError && error.code === "MALFORMED_RESPONSE"
      );
      assert.throws(
        () => validateJevResponse({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.5 } } }, questions),
        (error: unknown) => error instanceof JevError && error.code === "MALFORMED_RESPONSE"
      );
    });

    it("validates documented current API response schema (noul, choice, score, usage)", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              destructive: {
                type: "noul",
                noul: 0.95,
              },
              failure_class: {
                type: "choice",
                choice: "transient",
                probabilities: {
                  transient: 0.75,
                  environment: 0.1,
                  code_bug: 0.05,
                  permission: 0.05,
                  user_error: 0.05,
                  no_failure: 0.0,
                },
                confidence: 0.85,
              },
              impact: {
                type: "score",
                score: 2.8,
                legend: {
                  "0": "None",
                  "1": "Small",
                  "2": "Large",
                  "3": "Severe",
                },
                probabilities: {
                  "0": 0.05,
                  "1": 0.15,
                  "2": 0.6,
                  "3": 0.2,
                },
                confidence: 0.88,
              },
            },
            usage: {
              input_tokens: 128,
              output_tokens: 42,
            },
          }),
          { status: 200 }
        );
      };

      const questions: Record<string, JevQuestion> = {
        destructive: { type: "noul", instructions: "destructive?" },
        failure_class: {
          type: "choice",
          instructions: "failure class?",
          criteria: {
            transient: "retry",
            environment: null,
            code_bug: null,
            permission: null,
            user_error: null,
            no_failure: null,
          },
        },
        impact: {
          type: "score",
          instructions: "impact?",
          criteria: ["None", "Small", "Large", "Severe"],
        },
      };

      const res = await askJev({
        apiKey: "test-key",
        state: {},
        questions,
        fetch: mockFetch,
      });

      // Assert Noul answer
      assert.equal(res.answers.destructive.type, "noul");
      // @ts-expect-error test documented schema
      assert.equal(res.answers.destructive.noul, 0.95);

      // Assert Choice answer
      assert.equal(res.answers.failure_class.type, "choice");
      assert.equal(res.answers.failure_class.choice, "transient");
      // @ts-expect-error test documented schema
      assert.deepEqual(res.answers.failure_class.probabilities, {
        transient: 0.75,
        environment: 0.1,
        code_bug: 0.05,
        permission: 0.05,
        user_error: 0.05,
        no_failure: 0.0,
      });
      assert.equal(res.answers.failure_class.confidence, 0.85);

      // Assert Score answer
      assert.equal(res.answers.impact.type, "score");
      assert.equal(res.answers.impact.score, 2.8);
      // @ts-expect-error test documented schema
      assert.deepEqual(res.answers.impact.legend, {
        "0": "None",
        "1": "Small",
        "2": "Large",
        "3": "Severe",
      });
      // @ts-expect-error test documented schema
      assert.deepEqual(res.answers.impact.probabilities, {
        "0": 0.05,
        "1": 0.15,
        "2": 0.6,
        "3": 0.2,
      });
      assert.equal(res.answers.impact.confidence, 0.88);

      // Assert Usage
      assert.equal(res.usage?.input_tokens, 128);
      assert.equal(res.usage?.output_tokens, 42);
    });

    it("validates full response with noul, score, and choice answers", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              destructive: { type: "noul", noul: 0.95 },
              impact: {
                type: "score",
                score: 0.88,
                legend: { "0": "low", "1": "high" },
                probabilities: { "0": 0.12, "1": 0.88 },
                confidence: 0.88,
              },
              failure_class: {
                type: "choice",
                choice: "transient",
                probabilities: { transient: 0.75, no_failure: 0.25 },
                confidence: 0.75,
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 }
        );
      };

      const questions: Record<string, JevQuestion> = {
        destructive: { type: "noul", instructions: "destructive?" },
        impact: { type: "score", instructions: "impact?", criteria: ["low", "high"] },
        failure_class: {
          type: "choice",
          instructions: "failure class?",
          criteria: { transient: "retry", no_failure: null },
        },
      };

      const res = await askJev({
        apiKey: "test-key",
        state: {},
        questions,
        fetch: mockFetch,
      });

      assert.equal(res.answers.destructive.noul, 0.95);
      assert.equal(res.answers.impact.score, 0.88);
      assert.equal(res.answers.impact.confidence, 0.88);
      assert.equal(res.answers.failure_class.choice, "transient");
      assert.equal(res.answers.failure_class.confidence, 0.75);
    });

    it("throws MALFORMED_JSON when response is not valid JSON", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response("<html>Gateway 502 Bad Gateway</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_JSON");
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when response body is not a JSON object", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify(["array", "not", "object"]), { status: 200 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when answers object is missing", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ model: "jev-latest" }), { status: 200 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when an expected question answer is missing", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ answers: { destructive: { type: "noul", noul: 0.1 } } }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {
              destructive: { type: "noul", instructions: "d" },
              impact: { type: "score", instructions: "i", criteria: [] },
            },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /missing answer for question 'impact'/i);
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when answer type does not match question type", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              q1: {
                type: "choice",
                choice: "invalid",
                probabilities: { invalid: 1.0 },
                confidence: 0.9,
              },
            },
          }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "noul", instructions: "q" } },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /does not match question type 'noul'/i);
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when noul answer has invalid or non-finite noul value", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ answers: { q1: { type: "noul", noul: "high" } } }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "noul", instructions: "q" } },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /noul/i);
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when score answer has missing or invalid score", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              q1: {
                type: "score",
                legend: { a: "b" },
                probabilities: { a: 1.0 },
                confidence: 0.9,
              },
            },
          }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "score", instructions: "q", criteria: [] } },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /score/i);
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when score answer is missing legend or probabilities", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              q1: {
                type: "score",
                score: 2.0,
                confidence: 0.9,
              },
            },
          }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "score", instructions: "q", criteria: [] } },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /legend/i);
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when choice answer has missing or invalid choice", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              q1: {
                type: "choice",
                probabilities: { a: 1.0 },
                confidence: 0.8,
              },
            },
          }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "choice", instructions: "q", criteria: {} } },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /choice/i);
          return true;
        }
      );
    });

    it("throws MALFORMED_RESPONSE when choice answer is missing probabilities", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            answers: {
              q1: {
                type: "choice",
                choice: "a",
                confidence: 0.8,
              },
            },
          }),
          { status: 200 }
        );
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: { q1: { type: "choice", instructions: "q", criteria: { a: "A" } } },
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.equal(err.code, "MALFORMED_RESPONSE");
          assert.match(err.message, /probabilities/i);
          return true;
        }
      );
    });
  });

  describe("Bounded error text", () => {
    it("bounds oversized error response body with the …[N chars elided] marker", async () => {
      const longBody = "A".repeat(1200);
      const mockFetch: typeof fetch = async () => {
        return new Response(longBody, { status: 400, statusText: "Bad Request" });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.match(err.message, /…\[\d+ chars elided\]/);
          assert.ok(err.message.length < 1000);
          return true;
        }
      );
    });

    it("preserves short error response body without truncation marker", async () => {
      const shortBody = "Invalid field 'tool_input'";
      const mockFetch: typeof fetch = async () => {
        return new Response(shortBody, { status: 400 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: "test-key",
            state: {},
            questions: {},
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.match(err.message, /Invalid field 'tool_input'/);
          assert.doesNotMatch(err.message, /chars elided/);
          return true;
        }
      );
    });
  });

  describe("API key registration and redaction", () => {
    it("redacts registered API key from diagnostics and errors", () => {
      registerApiKey("ts-secret-alpha-999");
      const text = "Error sending request with Bearer ts-secret-alpha-999 to server";
      const redacted = redact(text);
      assert.equal(redacted, "Error sending request with Bearer [REDACTED] to server");
    });

    it("redacts multiple registered keys", () => {
      registerApiKey("key-one-111");
      registerApiKey("key-two-222");
      const text = "Keys: key-one-111 and key-two-222";
      const redacted = redact(text);
      assert.equal(redacted, "Keys: [REDACTED] and [REDACTED]");
    });

    it("redacts process.env.TYPESAFE_API_KEY automatically", () => {
      process.env.TYPESAFE_API_KEY = "env-secret-99999";
      const text = "Diagnostic: found env-secret-99999 in logs";
      assert.equal(redact(text), "Diagnostic: found [REDACTED] in logs");
    });

    it("askJev registers and redacts the apiKey used if an error occurs", async () => {
      const secretKey = "ts-super-secret-key-xyz";
      const mockFetch: typeof fetch = async () => {
        return new Response(`Error: API key ${secretKey} was rejected`, { status: 401 });
      };

      await assert.rejects(
        async () => {
          await askJev({
            apiKey: secretKey,
            state: {},
            questions: {},
            fetch: mockFetch,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof JevError);
          assert.doesNotMatch(err.message, new RegExp(secretKey));
          assert.match(err.message, /\[REDACTED\]/);
          return true;
        }
      );
    });

    it("redact handles non-string and empty inputs gracefully", () => {
      // @ts-expect-error test non-string runtime safety
      assert.equal(redact(undefined), "");
      // @ts-expect-error test non-string runtime safety
      assert.equal(redact(null), "");
      assert.equal(redact(""), "");
      assert.equal(redact("plain text without secrets"), "plain text without secrets");
    });
  });
});
