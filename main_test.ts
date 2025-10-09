import { assertEquals } from "jsr:@std/assert";
import { broadcastRequest, fetchPods, serverHandler } from "./main.ts";

const port = parseInt(Deno.env.get("PORT") || "1993");

let fetchCallCount = 0;

let broadcastedRequests: { url: string; method: string }[] = [];

const timeouts: number[] = [];

// Mock fetch for fetchPods and broadcastRequest tests.
globalThis.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit | undefined,
): Promise<Response> => {
  // Increase the counter.
  fetchCallCount++;

  const url = typeof input === "string" ? input : input.toString();

  // Add 20ms delay, so that we can test the wait property of serverHandler.
  // Add to the timeout array so that it can be cleared afrer each test.
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 10);
    timeouts.push(timeout);
  });

  // Mock response for fetchPods tests.
  if (url.includes("/api/v1/namespaces/default/pods")) {
    // Check for Authorization header
    const headers =
      input instanceof Request ? input.headers : new Headers(init?.headers);

    const auth = headers?.get("Authorization") ?? headers?.get("authorization");

    if (auth !== "Bearer fake-token") {
      return new Response(
        "Unauthorized: missing or invalid Authorization header",
        { status: 401 },
      );
    }

    const mockData = {
      items: [
        {
          status: {
            podIP: "10.0.0.1",
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
        {
          status: {
            podIP: "10.0.0.2",
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
      ],
    };

    return new Response(JSON.stringify(mockData), { status: 200 });
  }

  // Mock responses for broadcastRequest tests.

  // Simulate a fetch error for invalid IPs.
  if (url.includes("256.256.256.256")) {
    broadcastedRequests.push({ url, method: init?.method || "GET" });
    return new Response("Fetch error", { status: 500 });
  }

  if (url.startsWith("http://")) {
    broadcastedRequests.push({ url, method: init?.method || "GET" });

    return new Response("OK", { status: 200 });
  }

  return new Response("Not Found", { status: 404 });
};

Deno.test.afterEach(() => {
  // Clear all timeouts used in the mock fetch.
  timeouts.forEach((timeout) => clearTimeout(timeout));
  timeouts.length = 0;
  // Reset fetch call count.
  fetchCallCount = 0;
  // Clear broadcasted requests.
  broadcastedRequests = [];
});

/**
 * Test fetchPods
 */

Deno.test("fetchPods returns pod IPs from mock Kubernetes API", async () => {
  const pods = await fetchPods();
  assertEquals(pods, ["10.0.0.1", "10.0.0.2"]);
});

Deno.test("fetchPods uses cached value", async () => {
  // Call fetchPods for a first time.
  await fetchPods();

  // Get the number of times fetch has been called.
  const fetchCalls1 = fetchCallCount;

  // Call fetchPods for a second time.
  const pods = await fetchPods();

  // Test that fetchCalls did not increase.
  assertEquals(fetchCalls1, fetchCallCount);

  // Test that we get the expected value.
  assertEquals(pods, ["10.0.0.1", "10.0.0.2"]);
});

Deno.test("fetchPods refreshes cache after duration", async () => {
  // Call fetchPods for a first time.
  await fetchPods();

  // Get the number of times fetch has been called.
  const fetchCalls1 = fetchCallCount;

  // Wait for 600ms
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Call fetchPods for a second time.
  const pods = await fetchPods();

  // Test that fetchCalls increased.
  assertEquals(fetchCalls1 + 1, fetchCallCount);

  // Test that we get the expected value.
  assertEquals(pods, ["10.0.0.1", "10.0.0.2"]);
});

/**
 * Test broadcastRequest
 */

Deno.test("broadcastRequest sends requests to all pod IPs", async () => {
  const podIPs = ["10.0.0.1", "10.0.0.2"];
  const results = await broadcastRequest(podIPs, {
    pathname: "/test",
    method: "POST",
    port: 8080,
  });
  assertEquals(broadcastedRequests, [
    { url: "http://10.0.0.1:8080/test", method: "POST" },
    { url: "http://10.0.0.2:8080/test", method: "POST" },
  ]);
  assertEquals(results, [
    { ip: "10.0.0.1", status: 200 },
    { ip: "10.0.0.2", status: 200 },
  ]);
});

Deno.test("broadcastRequest handles fetch errors gracefully", async () => {
  const podIPs = ["256.256.256.256"]; // Invalid IP to trigger fetch error
  const results = await broadcastRequest(podIPs, {
    pathname: "/test",
    method: "GET",
    port: 8080,
  });
  // Even though the fetch fails, the function should complete without throwing.
  assertEquals(broadcastedRequests.length, 0); // No successful requests recorded
  assertEquals(results[0].ip, "256.256.256.256");
  assertEquals(results[0].status, null);
  assertEquals(typeof results[0].error, "string");
});

/**
 * Test server handler
 */

Deno.test(
  "serverHandler responds to /broadcast requests and waits for completion",
  async () => {
    const request = new Request(
      `http://localhost:${port}/broadcast/test/page?_port=8081&_wait=true`,
      {
        method: "PUT",
      },
    );
    const response = await serverHandler(request);
    assertEquals(response.status, 200);
    const text = await response.text();
    assertEquals(text, "Broadcast complete");
    assertEquals(broadcastedRequests, [
      { url: "http://10.0.0.1:8081/test/page", method: "PUT" },
      { url: "http://10.0.0.2:8081/test/page", method: "PUT" },
    ]);
  },
);

Deno.test(
  "serverHandler responds to /broadcast requests without waiting for completion",
  async () => {
    const request = new Request(
      `http://localhost:${port}/broadcast/test?example=1`,
      {
        method: "DELETE",
      },
    );
    const response = await serverHandler(request);
    assertEquals(response.status, 202);
    const text = await response.text();
    assertEquals(text, "Broadcast started");

    assertEquals(broadcastedRequests, []); // Should be empty immediately after response

    // Wait a bit to allow async broadcast to complete.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(broadcastedRequests, [
      { url: "http://10.0.0.1:8080/test?example=1", method: "DELETE" },
      { url: "http://10.0.0.2:8080/test?example=1", method: "DELETE" },
    ]);
  },
);

Deno.test(
  "serverHandler responds to /broadcast/purge-cache/ requests",
  async () => {
    const request = new Request(
      `http://localhost:${port}/broadcast/purge-cache/?_wait=true`,
      {
        method: "GET",
      },
    );
    const response = await serverHandler(request);
    assertEquals(response.status, 200);
    const text = await response.text();
    assertEquals(text, "Broadcast complete");
    assertEquals(broadcastedRequests, [
      {
        url: "http://10.0.0.1:8080/purge-cache/",
        method: "GET",
      },
      {
        url: "http://10.0.0.2:8080/purge-cache/",
        method: "GET",
      },
    ]);
  },
);
