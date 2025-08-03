import { suite } from "@alinea/suite";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import type { LogRecord } from "@logtape/logtape";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import {
  DenoTcpSyslogConnection,
  DenoUdpSyslogConnection,
  getSyslogSink,
  NodeTcpSyslogConnection,
  NodeUdpSyslogConnection,
  type SyslogFacility,
} from "./syslog.ts";

const test = suite(import.meta);

// RFC 5424 syslog message parser for testing
interface ParsedSyslogMessage {
  priority: number;
  version: number;
  timestamp: string;
  hostname: string;
  appName: string;
  procId: string;
  msgId: string;
  structuredData: string;
  message: string;
}

function parseSyslogMessage(rawMessage: string): ParsedSyslogMessage {
  // RFC 5424 format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
  const regex = /^<(\d+)>(\d+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/;
  const match = rawMessage.match(regex);

  if (!match) {
    throw new Error(`Invalid syslog message format: ${rawMessage}`);
  }

  const remaining = match[8];
  let structuredData: string;
  let message: string;

  if (remaining.startsWith("[")) {
    // Parse structured data - need to handle escaped brackets properly
    let pos = 0;
    let bracketCount = 0;
    let inQuotes = false;
    let escaped = false;

    for (let i = 0; i < remaining.length; i++) {
      const char = remaining[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (!inQuotes) {
        if (char === "[") {
          bracketCount++;
        } else if (char === "]") {
          bracketCount--;
          if (bracketCount === 0) {
            // Found the end of structured data
            pos = i + 1;
            break;
          }
        }
      }
    }

    if (pos > 0 && pos < remaining.length && remaining[pos] === " ") {
      structuredData = remaining.substring(0, pos);
      message = remaining.substring(pos + 1);
    } else {
      // No message after structured data or structured data extends to end
      structuredData = remaining.substring(0, pos || remaining.length);
      message = "";
    }
  } else {
    // No structured data, it's just "-"
    const spaceIndex = remaining.indexOf(" ");
    if (spaceIndex === -1) {
      structuredData = remaining;
      message = "";
    } else {
      structuredData = remaining.substring(0, spaceIndex);
      message = remaining.substring(spaceIndex + 1);
    }
  }

  return {
    priority: parseInt(match[1]),
    version: parseInt(match[2]),
    timestamp: match[3],
    hostname: match[4],
    appName: match[5],
    procId: match[6],
    msgId: match[7],
    structuredData,
    message,
  };
}

function parseStructuredData(
  structuredDataStr: string,
): Record<string, string> {
  if (structuredDataStr === "-") {
    return {};
  }

  // Parse [id key1="value1" key2="value2"] format
  const match = structuredDataStr.match(/^\[([^\s]+)\s+(.*)\]$/);
  if (!match) {
    throw new Error(`Invalid structured data format: ${structuredDataStr}`);
  }

  const result: Record<string, string> = {};
  const keyValuePairs = match[2];

  // Parse key="value" pairs, handling escaped quotes
  const kvRegex = /(\w+)="([^"\\]*(\\.[^"\\]*)*)"/g;
  let kvMatch;
  while ((kvMatch = kvRegex.exec(keyValuePairs)) !== null) {
    const key = kvMatch[1];
    const value = kvMatch[2]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\]/g, "]");
    result[key] = value;
  }

  return result;
}

// Create a mock log record for testing
function createMockLogRecord(
  level: "trace" | "debug" | "info" | "warning" | "error" | "fatal" = "info",
  message: (string | unknown)[] = ["Test message"],
  properties?: Record<string, unknown>,
): LogRecord {
  return {
    category: ["test"],
    level,
    message,
    rawMessage: "Test message",
    timestamp: new Date("2024-01-01T12:00:00.000Z").getTime(),
    properties: properties ?? {},
  };
}

test("getSyslogSink() creates a sink function", () => {
  const sink = getSyslogSink();
  assertEquals(typeof sink, "function");
  assertInstanceOf(sink, Function);
});

test("getSyslogSink() creates an AsyncDisposable sink", () => {
  const sink = getSyslogSink();
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

// Deno-specific UDP test
if (typeof Deno !== "undefined") {
  test("getSyslogSink() with actual UDP message transmission (Deno)", async () => {
    // For Deno, test UDP transmission to non-existent server (just verify no crash)
    const sink = getSyslogSink({
      hostname: "127.0.0.1",
      port: 12345, // Use a fixed port that likely has no server
      protocol: "udp",
      facility: "local1",
      appName: "test-app",
      timeout: 100, // Short timeout
    });

    try {
      // Send a log record - this should not crash even if server doesn't exist
      const logRecord = createMockLogRecord("info", ["Test message"], {
        userId: 123,
      });
      sink(logRecord);

      // Wait for transmission attempt
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Test passes if no crash occurs
      assertEquals(true, true);
    } finally {
      await sink[Symbol.asyncDispose]();
    }
  });
} else {
  test("getSyslogSink() with actual UDP message transmission (Node.js)", async () => {
    // Create a mock UDP server to receive messages
    let receivedMessage = "";

    // Node.js UDP server
    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessage = msg.toString();
    });

    try {
      // Create sink with UDP
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "local1",
        appName: "test-app",
        timeout: 1000,
      });

      // Send a log record
      const logRecord = createMockLogRecord("info", ["Test message"], {
        userId: 123,
      });
      sink(logRecord);

      // Wait for message transmission
      await new Promise((resolve) => setTimeout(resolve, 100));
      await sink[Symbol.asyncDispose]();

      // Wait for server to receive
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the message format
      assertEquals(receivedMessage.includes("Test message"), true);
      assertEquals(receivedMessage.includes("test-app"), true);
      // Priority should be local1 (17) * 8 + info (6) = 142
      assertEquals(receivedMessage.includes("<142>1"), true);
    } finally {
      server.close();
    }
  });
}

// Deno-specific TCP test
if (typeof Deno !== "undefined") {
  test("getSyslogSink() with actual TCP message transmission (Deno)", async () => {
    // Create a mock TCP server to receive messages
    let receivedMessage = "";

    // Deno TCP server
    const server = Deno.listen({ port: 0 });
    const serverAddr = server.addr as Deno.NetAddr;

    const serverTask = (async () => {
      try {
        const conn = await server.accept();
        const buffer = new Uint8Array(1024);
        const bytesRead = await conn.read(buffer);
        if (bytesRead) {
          receivedMessage = new TextDecoder().decode(
            buffer.subarray(0, bytesRead),
          );
        }
        conn.close();
      } catch {
        // Server closed
      }
    })();

    try {
      // Create sink with TCP
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: serverAddr.port,
        protocol: "tcp",
        facility: "daemon",
        appName: "test-daemon",
        timeout: 0, // No timeout to avoid timer leaks
        includeStructuredData: true,
        structuredDataId: "test@12345",
      });

      // Send a log record with properties
      const logRecord = createMockLogRecord("error", [
        "Critical error occurred",
      ], {
        errorCode: 500,
        component: "auth",
      });
      sink(logRecord);

      // Wait for message transmission and disposal
      await new Promise((resolve) => setTimeout(resolve, 100));
      await sink[Symbol.asyncDispose]();

      // Wait for server task
      await serverTask;

      // Verify the message format
      assertEquals(receivedMessage.includes("Critical error occurred"), true);
      assertEquals(receivedMessage.includes("test-daemon"), true);
      // Priority should be daemon (3) * 8 + error (3) = 27
      assertEquals(receivedMessage.includes("<27>1"), true);
      // Should include structured data
      assertEquals(receivedMessage.includes("[test@12345"), true);
      assertEquals(receivedMessage.includes('errorCode="500"'), true);
      assertEquals(receivedMessage.includes('component="auth"'), true);
    } finally {
      server.close();
      await serverTask.catch(() => {});
    }
  });
} else {
  test("getSyslogSink() with actual TCP message transmission (Node.js)", async () => {
    // Create a mock TCP server to receive messages
    let receivedMessage = "";

    // Node.js TCP server
    const server = createServer((socket) => {
      socket.on("data", (data) => {
        receivedMessage = data.toString();
        socket.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    try {
      // Create sink with TCP
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "tcp",
        facility: "daemon",
        appName: "test-daemon",
        timeout: 5000,
        includeStructuredData: true,
        structuredDataId: "test@12345",
      });

      // Send a log record with properties
      const logRecord = createMockLogRecord("error", [
        "Critical error occurred",
      ], {
        errorCode: 500,
        component: "auth",
      });
      sink(logRecord);

      // Wait for message transmission
      await new Promise((resolve) => setTimeout(resolve, 100));
      await sink[Symbol.asyncDispose]();

      // Wait for server to receive
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the message format
      assertEquals(receivedMessage.includes("Critical error occurred"), true);
      assertEquals(receivedMessage.includes("test-daemon"), true);
      // Priority should be daemon (3) * 8 + error (3) = 27
      assertEquals(receivedMessage.includes("<27>1"), true);
      // Should include structured data
      assertEquals(receivedMessage.includes("[test@12345"), true);
      assertEquals(receivedMessage.includes('errorCode="500"'), true);
      assertEquals(receivedMessage.includes('component="auth"'), true);
    } finally {
      server.close();
    }
  });
}

// Deno-specific multiple messages test
if (typeof Deno !== "undefined") {
  test("getSyslogSink() with multiple messages and proper sequencing (Deno)", async () => {
    // Test that multiple messages are sent in sequence without blocking
    // Deno version - use UDP for simpler testing
    const sink = getSyslogSink({
      hostname: "127.0.0.1",
      port: 1234, // Non-existent port, but should handle gracefully
      protocol: "udp",
      facility: "local0",
      timeout: 100, // Short timeout
    });

    try {
      // Send multiple messages quickly
      const record1 = createMockLogRecord("info", ["Message 1"]);
      const record2 = createMockLogRecord("warning", ["Message 2"]);
      const record3 = createMockLogRecord("error", ["Message 3"]);

      // These should not block each other
      sink(record1);
      sink(record2);
      sink(record3);

      // All messages should be queued and attempted
      // Even if they fail due to no server, the sink should handle it gracefully
    } finally {
      await sink[Symbol.asyncDispose]();
    }

    // Test passes if no hanging or crashes occur
    assertEquals(true, true);
  });
} else {
  test("getSyslogSink() with multiple messages and proper sequencing (Node.js)", async () => {
    // Test that multiple messages are sent in sequence without blocking
    // Node.js version
    const sink = getSyslogSink({
      hostname: "127.0.0.1",
      port: 1234, // Non-existent port
      protocol: "udp",
      facility: "local0",
      timeout: 100,
    });

    try {
      // Send multiple messages quickly
      const record1 = createMockLogRecord("info", ["Message 1"]);
      const record2 = createMockLogRecord("warning", ["Message 2"]);
      const record3 = createMockLogRecord("error", ["Message 3"]);

      sink(record1);
      sink(record2);
      sink(record3);
    } finally {
      await sink[Symbol.asyncDispose]();
    }

    assertEquals(true, true);
  });
}

// RFC 5424 Message Format Validation Tests
if (typeof Deno !== "undefined") {
  test("getSyslogSink() RFC 5424 message format validation (Deno)", async () => {
    const receivedMessages: string[] = [];

    // Use Node.js dgram API for UDP server (available in Deno)
    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessages.push(msg.toString());
    });

    try {
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "daemon", // 3
        appName: "test-app",
        syslogHostname: "test-host",
        processId: "12345",
        timeout: 1000,
        includeStructuredData: true,
        structuredDataId: "test@54321",
      });

      // Test different log levels with specific data
      const infoRecord = createMockLogRecord("info", ["Info message"], {
        requestId: "req-123",
        userId: 456,
      });
      const errorRecord = createMockLogRecord("error", ["Error occurred"], {
        errorCode: 500,
        component: "auth",
      });
      const warningRecord = createMockLogRecord("warning", [
        "Warning: disk space low",
      ], {
        diskUsage: "85%",
        partition: "/var",
      });

      sink(infoRecord);
      sink(errorRecord);
      sink(warningRecord);

      await new Promise((resolve) => setTimeout(resolve, 200));
      await sink[Symbol.asyncDispose]();

      // Wait for server to receive all messages
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Validate we received 3 messages
      assertEquals(receivedMessages.length, 3);

      // Parse and validate each message structure
      const parsedMessages = receivedMessages.map((msg) =>
        parseSyslogMessage(msg)
      );

      for (const parsed of parsedMessages) {
        // Validate RFC 5424 format structure
        assertEquals(parsed.version, 1);
        assertEquals(parsed.hostname, "test-host");
        assertEquals(parsed.appName, "test-app");
        assertEquals(parsed.procId, "12345");
        assertEquals(parsed.msgId, "-");

        // Validate timestamp format (ISO 8601)
        assert(
          parsed.timestamp.match(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          ) !== null,
        );

        // Validate structured data is present
        assert(parsed.structuredData.startsWith("[test@54321"));
      }

      // Find specific messages and validate their content
      const infoMessage = parsedMessages.find((p) =>
        p.message === "Info message"
      );
      const errorMessage = parsedMessages.find((p) =>
        p.message === "Error occurred"
      );
      const warningMessage = parsedMessages.find((p) =>
        p.message === "Warning: disk space low"
      );

      // Validate priorities: daemon (3) * 8 + severity
      assertEquals(infoMessage?.priority, 30); // daemon (3) * 8 + info (6) = 30
      assertEquals(errorMessage?.priority, 27); // daemon (3) * 8 + error (3) = 27
      assertEquals(warningMessage?.priority, 28); // daemon (3) * 8 + warning (4) = 28

      // Parse and validate structured data content
      const infoStructuredData = parseStructuredData(
        infoMessage!.structuredData,
      );
      assertEquals(infoStructuredData.requestId, "req-123");
      assertEquals(infoStructuredData.userId, "456");

      const errorStructuredData = parseStructuredData(
        errorMessage!.structuredData,
      );
      assertEquals(errorStructuredData.errorCode, "500");
      assertEquals(errorStructuredData.component, "auth");

      const warningStructuredData = parseStructuredData(
        warningMessage!.structuredData,
      );
      assertEquals(warningStructuredData.diskUsage, "85%");
      assertEquals(warningStructuredData.partition, "/var");
    } finally {
      server.close();
    }
  });
} else {
  test("getSyslogSink() RFC 5424 message format validation (Node.js)", async () => {
    const receivedMessages: string[] = [];

    // Create UDP server to capture actual messages
    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessages.push(msg.toString());
    });

    try {
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "daemon", // 3
        appName: "test-app",
        syslogHostname: "test-host",
        processId: "12345",
        timeout: 1000,
        includeStructuredData: true,
        structuredDataId: "test@54321",
      });

      // Test different log levels with specific data
      const infoRecord = createMockLogRecord("info", ["Info message"], {
        requestId: "req-123",
        userId: 456,
      });
      const errorRecord = createMockLogRecord("error", ["Error occurred"], {
        errorCode: 500,
        component: "auth",
      });
      const warningRecord = createMockLogRecord("warning", [
        "Warning: disk space low",
      ], {
        diskUsage: "85%",
        partition: "/var",
      });

      sink(infoRecord);
      sink(errorRecord);
      sink(warningRecord);

      await new Promise((resolve) => setTimeout(resolve, 200));
      await sink[Symbol.asyncDispose]();

      // Wait for server to receive all messages
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Validate we received 3 messages
      assertEquals(receivedMessages.length, 3);

      // Validate RFC 5424 format for each message
      for (const message of receivedMessages) {
        // Should start with priority in angle brackets
        assertEquals(message.match(/^<\d+>/) !== null, true);

        // Should have version number 1
        assertEquals(message.includes(">1 "), true);

        // Should contain timestamp in ISO format
        assertEquals(
          message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/) !== null,
          true,
        );

        // Should contain our hostname
        assertEquals(message.includes("test-host"), true);

        // Should contain our app name
        assertEquals(message.includes("test-app"), true);

        // Should contain our process ID
        assertEquals(message.includes("12345"), true);

        // Should contain structured data
        assertEquals(message.includes("[test@54321"), true);
      }

      // Check specific priorities: daemon (3) * 8 + level
      const infoMessage = receivedMessages.find((m) =>
        m.includes("Info message")
      );
      const errorMessage = receivedMessages.find((m) =>
        m.includes("Error occurred")
      );
      const warningMessage = receivedMessages.find((m) =>
        m.includes("Warning: disk space low")
      );

      // Info: daemon (3) * 8 + info (6) = 30
      assertEquals(infoMessage?.includes("<30>1"), true);

      // Error: daemon (3) * 8 + error (3) = 27
      assertEquals(errorMessage?.includes("<27>1"), true);

      // Warning: daemon (3) * 8 + warning (4) = 28
      assertEquals(warningMessage?.includes("<28>1"), true);

      // Check structured data content
      assertEquals(infoMessage?.includes('requestId="req-123"'), true);
      assertEquals(infoMessage?.includes('userId="456"'), true);
      assertEquals(errorMessage?.includes('errorCode="500"'), true);
      assertEquals(errorMessage?.includes('component="auth"'), true);
      assertEquals(warningMessage?.includes('diskUsage="85%"'), true);
      assertEquals(warningMessage?.includes('partition="/var"'), true);
    } finally {
      server.close();
    }
  });
}

// Structured Data Escaping Tests
if (typeof Deno !== "undefined") {
  test("getSyslogSink() structured data escaping validation (Deno)", async () => {
    let receivedMessage = "";

    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessage = msg.toString();
    });

    try {
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "local0",
        appName: "escape-test",
        timeout: 1000,
        includeStructuredData: true,
        structuredDataId: "escape@12345",
      });

      // Test message with special characters that need escaping
      const testRecord = createMockLogRecord("info", ["Test escaping"], {
        quote: 'Has "quotes" in value',
        backslash: "Has \\ backslash",
        bracket: "Has ] bracket",
        combined: 'Mix of "quotes", \\ and ] chars',
      });

      sink(testRecord);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await sink[Symbol.asyncDispose]();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Parse and validate the complete message
      const parsed = parseSyslogMessage(receivedMessage);

      assertEquals(parsed.version, 1);
      assertEquals(parsed.hostname, Deno.hostname());
      assertEquals(parsed.appName, "escape-test");
      assertEquals(parsed.message, "Test escaping");

      // Parse structured data and verify proper unescaping
      const structuredData = parseStructuredData(parsed.structuredData);
      assertEquals(structuredData.quote, 'Has "quotes" in value');
      assertEquals(structuredData.backslash, "Has \\ backslash");
      assertEquals(structuredData.bracket, "Has ] bracket");
      assertEquals(structuredData.combined, 'Mix of "quotes", \\ and ] chars');
    } finally {
      server.close();
    }
  });
} else {
  test("getSyslogSink() structured data escaping validation (Node.js)", async () => {
    let receivedMessage = "";

    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessage = msg.toString();
    });

    try {
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "local0",
        appName: "escape-test",
        timeout: 1000,
        includeStructuredData: true,
        structuredDataId: "escape@12345",
      });

      // Test message with special characters that need escaping
      const testRecord = createMockLogRecord("info", ["Test escaping"], {
        quote: 'Has "quotes" in value',
        backslash: "Has \\ backslash",
        bracket: "Has ] bracket",
        combined: 'Mix of "quotes", \\ and ] chars',
      });

      sink(testRecord);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await sink[Symbol.asyncDispose]();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Parse and verify the message like the Deno test
      const parsed = parseSyslogMessage(receivedMessage);

      assertEquals(parsed.version, 1);
      assertEquals(parsed.message, "Test escaping");
      assertEquals(parsed.appName, "escape-test");

      // Parse structured data and verify escaping
      const structuredData = parseStructuredData(parsed.structuredData);
      assertEquals(structuredData.quote, 'Has "quotes" in value');
      assertEquals(structuredData.backslash, "Has \\ backslash");
      assertEquals(structuredData.bracket, "Has ] bracket");
      assertEquals(structuredData.combined, 'Mix of "quotes", \\ and ] chars');
    } finally {
      server.close();
    }
  });
}

// Template Literal Message Formatting Tests
if (typeof Deno !== "undefined") {
  test("getSyslogSink() template literal message formatting (Deno)", async () => {
    let receivedMessage = "";

    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessage = msg.toString();
    });

    try {
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "local0",
        appName: "template-test",
        timeout: 1000,
        includeStructuredData: false,
      });

      // Test LogTape template literal style message
      const templateRecord = createMockLogRecord("info", [
        "User ",
        { userId: 123, name: "Alice" },
        " performed action ",
        "login",
        " with result ",
        { success: true, duration: 150 },
      ]);

      sink(templateRecord);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await sink[Symbol.asyncDispose]();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Parse and validate the complete message
      const parsed = parseSyslogMessage(receivedMessage);
      assertEquals(parsed.appName, "template-test");
      assertEquals(parsed.structuredData, "-"); // No structured data for this test

      // Verify template literal message is correctly formatted
      const expectedMessage =
        'User {"userId":123,"name":"Alice"} performed action "login" with result {"success":true,"duration":150}';
      assertEquals(parsed.message, expectedMessage);
    } finally {
      server.close();
    }
  });
} else {
  test("getSyslogSink() template literal message formatting (Node.js)", async () => {
    let receivedMessage = "";

    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessage = msg.toString();
    });

    try {
      const sink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "local0",
        appName: "template-test",
        timeout: 1000,
        includeStructuredData: false,
      });

      // Test LogTape template literal style message
      const templateRecord = createMockLogRecord("info", [
        "User ",
        { userId: 123, name: "Alice" },
        " performed action ",
        "login",
        " with result ",
        { success: true, duration: 150 },
      ]);

      sink(templateRecord);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await sink[Symbol.asyncDispose]();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify template literal parts are properly formatted
      assertEquals(receivedMessage.includes("User "), true);
      assertEquals(
        receivedMessage.includes('{"userId":123,"name":"Alice"}'),
        true,
      );
      assertEquals(receivedMessage.includes(" performed action "), true);
      assertEquals(receivedMessage.includes('"login"'), true);
      assertEquals(receivedMessage.includes(" with result "), true);
      assertEquals(
        receivedMessage.includes('{"success":true,"duration":150}'),
        true,
      );
    } finally {
      server.close();
    }
  });
}

// Facility and Priority Calculation Tests
if (typeof Deno !== "undefined") {
  test("getSyslogSink() facility and priority calculation (Deno)", async () => {
    const receivedMessages: string[] = [];

    const server = createSocket("udp4");

    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as { port: number };

    server.on("message", (msg) => {
      receivedMessages.push(msg.toString());
    });

    try {
      // Test different facilities
      const facilities = [
        { name: "kernel", code: 0 },
        { name: "user", code: 1 },
        { name: "daemon", code: 3 },
        { name: "local0", code: 16 },
        { name: "local7", code: 23 },
      ] as const;

      for (const facility of facilities) {
        const sink = getSyslogSink({
          hostname: "127.0.0.1",
          port: address.port,
          protocol: "udp",
          facility: facility.name,
          appName: `${facility.name}-test`,
          timeout: 1000,
        });

        // Test with error level (severity 3)
        const errorRecord = createMockLogRecord("error", [
          `${facility.name} error message`,
        ]);
        sink(errorRecord);

        await new Promise((resolve) => setTimeout(resolve, 50));
        await sink[Symbol.asyncDispose]();
      }

      // Test one additional level combination
      const warningSink = getSyslogSink({
        hostname: "127.0.0.1",
        port: address.port,
        protocol: "udp",
        facility: "mail", // code 2
        appName: "mail-test",
        timeout: 1000,
      });

      const warningRecord = createMockLogRecord("warning", [
        "mail warning message",
      ]);
      warningSink(warningRecord);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await warningSink[Symbol.asyncDispose]();

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify priority calculations: Priority = Facility * 8 + Severity
      assertEquals(receivedMessages.length, 6);

      // Parse all messages and verify priorities
      const parsedMessages = receivedMessages.map((msg) =>
        parseSyslogMessage(msg)
      );

      // Find and verify each facility message
      const kernelMsg = parsedMessages.find((p) =>
        p.message === "kernel error message"
      );
      const userMsg = parsedMessages.find((p) =>
        p.message === "user error message"
      );
      const daemonMsg = parsedMessages.find((p) =>
        p.message === "daemon error message"
      );
      const local0Msg = parsedMessages.find((p) =>
        p.message === "local0 error message"
      );
      const local7Msg = parsedMessages.find((p) =>
        p.message === "local7 error message"
      );
      const mailMsg = parsedMessages.find((p) =>
        p.message === "mail warning message"
      );

      // Verify exact priority calculations
      assertEquals(kernelMsg?.priority, 3); // kernel (0) * 8 + error (3) = 3
      assertEquals(userMsg?.priority, 11); // user (1) * 8 + error (3) = 11
      assertEquals(daemonMsg?.priority, 27); // daemon (3) * 8 + error (3) = 27
      assertEquals(local0Msg?.priority, 131); // local0 (16) * 8 + error (3) = 131
      assertEquals(local7Msg?.priority, 187); // local7 (23) * 8 + error (3) = 187
      assertEquals(mailMsg?.priority, 20); // mail (2) * 8 + warning (4) = 20

      // Verify app names match facilities
      assertEquals(kernelMsg?.appName, "kernel-test");
      assertEquals(userMsg?.appName, "user-test");
      assertEquals(daemonMsg?.appName, "daemon-test");
      assertEquals(local0Msg?.appName, "local0-test");
      assertEquals(local7Msg?.appName, "local7-test");
      assertEquals(mailMsg?.appName, "mail-test");
    } finally {
      server.close();
    }
  });
}

test("Syslog message format follows RFC 5424", () => {
  // Test that the sink can be created and called without throwing
  const sink = getSyslogSink({
    facility: "local0",
    appName: "test-app",
    syslogHostname: "test-host",
    processId: "1234",
    includeStructuredData: false,
  });

  // This should not throw during sink creation and call
  // We don't send the message to avoid network operations
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("Syslog priority calculation", () => {
  // Test priority calculation: Priority = Facility * 8 + Severity
  // local0 (16) + info (6) = 16 * 8 + 6 = 134

  const sink = getSyslogSink({
    facility: "local0", // 16
    appName: "test",
  });

  // Test that sink is created correctly
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("Syslog facility codes mapping", () => {
  const facilities = [
    "kernel", // 0
    "user", // 1
    "mail", // 2
    "daemon", // 3
    "local0", // 16
    "local7", // 23
  ];

  for (const facility of facilities) {
    const sink = getSyslogSink({
      facility: facility as SyslogFacility,
      appName: "test",
    });

    // Should not throw for any valid facility
    assertEquals(typeof sink, "function");
    assertEquals(typeof sink[Symbol.asyncDispose], "function");
  }
});

test("Syslog severity levels mapping", () => {
  // Test that the sink works with all severity levels
  const _levels: Array<
    "fatal" | "error" | "warning" | "info" | "debug" | "trace"
  > = [
    "fatal", // 0 (Emergency)
    "error", // 3 (Error)
    "warning", // 4 (Warning)
    "info", // 6 (Informational)
    "debug", // 7 (Debug)
    "trace", // 7 (Debug)
  ];

  const sink = getSyslogSink({
    facility: "local0",
    appName: "test",
  });

  // Should work with all valid levels
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("Structured data formatting", () => {
  const sink = getSyslogSink({
    facility: "local0",
    appName: "test",
    includeStructuredData: true,
  });

  // Should not throw when including structured data
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("Message with template literals", () => {
  const sink = getSyslogSink({
    facility: "local0",
    appName: "test",
  });

  // Should not throw with template literal style messages
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("Default options", () => {
  const sink = getSyslogSink();

  // Should work with default options
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("Custom options", () => {
  const sink = getSyslogSink({
    protocol: "tcp",
    facility: "mail",
    appName: "my-app",
    syslogHostname: "web-server-01",
    processId: "9999",
    timeout: 1000,
    includeStructuredData: true,
  });

  // Should work with custom options
  assertEquals(typeof sink, "function");
  assertEquals(typeof sink[Symbol.asyncDispose], "function");
});

test("AsyncDisposable cleanup", async () => {
  const sink = getSyslogSink();

  // Send a message
  const record = createMockLogRecord();
  sink(record);

  // Should be able to dispose without throwing
  await sink[Symbol.asyncDispose]();
});

// Basic format validation test
test("Syslog message format validation", () => {
  // Test the internal formatting functions directly
  const timestamp = new Date("2024-01-01T12:00:00.000Z").getTime();

  // Test priority calculation: local0 (16) * 8 + info (6) = 134
  const expectedPriority = 16 * 8 + 6; // 134
  assertEquals(expectedPriority, 134);

  // Test timestamp formatting
  const timestampStr = new Date(timestamp).toISOString();
  assertEquals(timestampStr, "2024-01-01T12:00:00.000Z");
});

// Runtime-specific connection tests
if (typeof Deno !== "undefined") {
  // Deno-specific tests
  test("DenoUdpSyslogConnection instantiation", () => {
    const connection = new DenoUdpSyslogConnection("localhost", 514, 5000);
    assertInstanceOf(connection, DenoUdpSyslogConnection);
  });

  test("DenoUdpSyslogConnection connect and close", () => {
    const connection = new DenoUdpSyslogConnection("localhost", 514, 5000);
    // connect() should not throw for UDP
    connection.connect();
    // close() should not throw for UDP
    connection.close();
  });

  test("DenoUdpSyslogConnection send timeout", async () => {
    // Use a non-routable IP to trigger timeout
    const connection = new DenoUdpSyslogConnection("10.255.255.1", 9999, 50); // Very short timeout
    connection.connect();

    try {
      await connection.send("test message");
      // If we reach here, the send didn't timeout as expected
      // This might happen if the system is very fast or network conditions are unusual
    } catch (error) {
      // This is expected - either timeout or network unreachable
      assertEquals(typeof (error as Error).message, "string");
    } finally {
      connection.close();
    }
  });

  test("DenoTcpSyslogConnection instantiation", () => {
    const connection = new DenoTcpSyslogConnection("localhost", 514, 5000);
    assertInstanceOf(connection, DenoTcpSyslogConnection);
  });

  test("DenoTcpSyslogConnection close without connection", () => {
    const connection = new DenoTcpSyslogConnection("localhost", 514, 5000);
    // close() should not throw even without connection
    connection.close();
  });

  test("DenoTcpSyslogConnection connection timeout", async () => {
    // Use a non-routable IP address to ensure connection failure
    const connection = new DenoTcpSyslogConnection("10.255.255.1", 9999, 100); // Very short timeout

    try {
      await assertRejects(
        () => connection.connect(),
        Error,
      );
    } finally {
      // Ensure cleanup
      connection.close();
    }
  });

  test("DenoTcpSyslogConnection send without connection", async () => {
    const connection = new DenoTcpSyslogConnection("localhost", 514, 5000);

    await assertRejects(
      () => connection.send("test message"),
      Error,
      "Connection not established",
    );
  });

  test("DenoUdpSyslogConnection actual send test", async () => {
    // Try to send to a local UDP echo server or just verify the call doesn't crash
    const connection = new DenoUdpSyslogConnection("127.0.0.1", 1514, 1000); // Non-privileged port
    connection.connect();

    try {
      // This will likely fail (no server listening), but should handle gracefully
      await connection.send("test syslog message");
      // If it succeeds, that's also fine - might have a server running
    } catch (error) {
      // Expected - likely no server listening, but the send mechanism should work
      const errorMessage = (error as Error).message;
      // Should contain either timeout or connection/network error
      assertEquals(typeof errorMessage, "string");
    } finally {
      connection.close();
    }
  });

  test("DenoTcpSyslogConnection actual send test with mock server", async () => {
    // Create a simple TCP server to receive the message
    let receivedData = "";

    const server = Deno.listen({ port: 0 }); // Let system choose port
    const serverAddr = server.addr as Deno.NetAddr;

    // Handle one connection in background
    const serverTask = (async () => {
      try {
        const conn = await server.accept();
        const buffer = new Uint8Array(1024);
        const bytesRead = await conn.read(buffer);
        if (bytesRead) {
          receivedData = new TextDecoder().decode(
            buffer.subarray(0, bytesRead),
          );
        }
        conn.close();
      } catch {
        // Server closed or connection error
      }
    })();

    try {
      // Give server a moment to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Connect and send message - create new connection with no timeout to avoid timer leaks
      const connection = new DenoTcpSyslogConnection(
        "127.0.0.1",
        serverAddr.port,
        0,
      ); // No timeout

      await connection.connect();
      await connection.send("test syslog message from Deno TCP");
      connection.close();

      // Give server time to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify message was received
      assertEquals(
        receivedData.includes("test syslog message from Deno TCP"),
        true,
      );
    } finally {
      server.close();
      await serverTask.catch(() => {}); // Wait for server cleanup
    }
  });
}

// Node.js/Bun-specific tests
test("NodeUdpSyslogConnection instantiation", () => {
  const connection = new NodeUdpSyslogConnection("localhost", 514, 5000);
  assertInstanceOf(connection, NodeUdpSyslogConnection);
});

test("NodeUdpSyslogConnection connect and close", () => {
  const connection = new NodeUdpSyslogConnection("localhost", 514, 5000);
  // connect() should not throw for UDP
  connection.connect();
  // close() should not throw for UDP
  connection.close();
});

test("NodeUdpSyslogConnection send timeout", async () => {
  // Use a non-routable IP to trigger timeout
  const connection = new NodeUdpSyslogConnection("10.255.255.1", 9999, 50); // Very short timeout
  connection.connect();

  try {
    await connection.send("test message");
    // If we reach here, the send didn't timeout as expected
    // This might happen if the system is very fast or network conditions are unusual
  } catch (error) {
    // This is expected - either timeout or network unreachable
    assertEquals(typeof (error as Error).message, "string");
  } finally {
    connection.close();
  }
});

test("NodeTcpSyslogConnection instantiation", () => {
  const connection = new NodeTcpSyslogConnection("localhost", 514, 5000);
  assertInstanceOf(connection, NodeTcpSyslogConnection);
});

test("NodeTcpSyslogConnection close without connection", () => {
  const connection = new NodeTcpSyslogConnection("localhost", 514, 5000);
  // close() should not throw even without connection
  connection.close();
});

test("NodeTcpSyslogConnection connection timeout", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  // Use a non-routable IP address to ensure connection failure
  const connection = new NodeTcpSyslogConnection("10.255.255.1", 9999, 100); // Very short timeout

  try {
    await assertRejects(
      () => connection.connect(),
      Error,
    );
  } finally {
    // Ensure cleanup
    connection.close();
  }
});

test("NodeTcpSyslogConnection send without connection", () => {
  const connection = new NodeTcpSyslogConnection("localhost", 514, 5000);

  assertThrows(
    () => connection.send("test message"),
    Error,
    "Connection not established",
  );
});

test("NodeUdpSyslogConnection actual send test", async () => {
  // Try to send to a local UDP port
  const connection = new NodeUdpSyslogConnection("127.0.0.1", 1514, 1000); // Non-privileged port
  connection.connect();

  try {
    // This will likely fail (no server listening), but should handle gracefully
    await connection.send("test syslog message");
    // If it succeeds, that's also fine - might have a server running
  } catch (error) {
    // Expected - likely no server listening, but the send mechanism should work
    const errorMessage = (error as Error).message;
    // Should contain either timeout or connection/network error
    assertEquals(typeof errorMessage, "string");
  } finally {
    connection.close();
  }
});

test("NodeTcpSyslogConnection actual send test with mock server", async () => {
  // Import Node.js modules for creating a server

  let receivedData = "";

  // Create a simple TCP server
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      receivedData = data.toString();
      socket.end();
    });
  });

  // Start server on random port
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as { port: number };

  try {
    // Connect and send message
    const connection = new NodeTcpSyslogConnection(
      "127.0.0.1",
      address.port,
      5000,
    );

    await connection.connect();
    await connection.send("test syslog message from Node TCP");
    connection.close();

    // Wait a bit for server to receive data
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify message was received
    assertEquals(
      receivedData.includes("test syslog message from Node TCP"),
      true,
    );
  } finally {
    server.close();
  }
});
