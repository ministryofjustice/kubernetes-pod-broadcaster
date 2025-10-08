import { assertEquals } from "jsr:@std/assert";

import { broadcastRequest, fetchPods } from "./main.ts";

const port = parseInt(Deno.env.get("PORT") || "1993");

let fetchCallCount = 0;

// Mock fetch for broadcastRequest tests.
let broadcastedRequests: { url: string; method: string }[] = [];

const initialFetchFunction = globalThis.fetch;

// Mock fetch for fetchPods and broadcastRequest tests.
globalThis.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit | undefined,
): Promise<Response> => {
  // Increase the counter.
  fetchCallCount++;

  const url = typeof input === "string" ? input : input.toString();

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
        { status: { podIP: "10.0.0.1" } },
        { status: { podIP: "10.0.0.2" } },
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
  broadcastedRequests = []; // Reset before test
  const podIPs = ["10.0.0.1", "10.0.0.2"];
  await broadcastRequest(podIPs, {
    pathname: "/test",
    method: "POST",
    port: 8080,
  });
  assertEquals(broadcastedRequests, [
    { url: "http://10.0.0.1:8080/test", method: "POST" },
    { url: "http://10.0.0.2:8080/test", method: "POST" },
  ]);
});

Deno.test("broadcastRequest handles fetch errors gracefully", async () => {
  broadcastedRequests = []; // Reset before test
  const podIPs = ["256.256.256.256"]; // Invalid IP to trigger fetch error
  await broadcastRequest(podIPs, {
    pathname: "/test",
    method: "GET",
    port: 8080,
  });
  // Even though the fetch fails, the function should complete without throwing.
  assertEquals(broadcastedRequests.length, 0); // No successful requests recorded
});

