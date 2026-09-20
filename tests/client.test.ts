import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  askJev,
  isRetryableStatus,
  registerApiKey,
  clearRegisteredApiKeys,
  redact,
  JevError,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  type JevCall,
  type JevQuestion,
  type JevResponse,
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
      assert.equal(DEFAULT_ENDPOINT, "https://api.typesafe.ai/v1/systemone");
      assert.equal(DEFAULT_TIMEOUT_MS, 20000);
      assert.equal(DEFAULT_RETRIES, 2);
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
            answers: {
              q1: { type: "noul", noul: 0.05 },
            },
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
          JSON.stringify({ answers: { q1: { type: "noul", noul: 0.1 } } }),
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
          JSON.stringify({ answers: { q1: { type: "noul", noul: 0.2 } } }),
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
          JSON.stringify({ answers: { q1: { type: "noul", noul: 0.3 } } }),
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
          JSON.stringify({ answers: { q1: { type: "noul", noul: 0.4 } } }),
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
          JSON.stringify({ answers: { q1: { type: "noul", noul: 0.5 } } }),
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
    it("times out per attempt and retries up to retry limit", async () => {
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

      assert.equal(callCount, 2); // 1 initial attempt + 1 retry
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
                score: 2.8,
                legend: { low: "low", high: "high" },
                probabilities: { low: 0.12, high: 0.88 },
                confidence: 0.88,
              },
              failure_class: {
                type: "choice",
                choice: "transient",
                probabilities: { transient: 0.75, no_failure: 0.25 },
                confidence: 0.75,
              },
            },
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
      assert.equal(res.answers.impact.score, 2.8);
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
            questions: { q1: { type: "choice", instructions: "q", criteria: {} } },
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
