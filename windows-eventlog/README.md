<!-- deno-fmt-ignore-file -->

LogTape Windows Event Log sink
==============================

[![JSR][JSR badge]][JSR]
[![npm][npm badge]][npm]

Windows Event Log sink for [LogTape]. This package provides a Windows Event Log
sink that sends log messages directly to the Windows Event Log system with
cross-runtime support and optimal performance.

[JSR]: https://jsr.io/@logtape/windows-eventlog
[JSR badge]: https://jsr.io/badges/@logtape/windows-eventlog
[npm]: https://www.npmjs.com/package/@logtape/windows-eventlog
[npm badge]: https://img.shields.io/npm/v/@logtape/windows-eventlog?logo=npm
[LogTape]: https://logtape.org/


Features
--------

 -  *Native Windows integration*: Direct integration with Windows Event Log
    system
 -  *Cross-runtime*: Works on Deno, Node.js, and Bun
 -  *High performance*: Uses runtime-optimized FFI implementations
 -  *Structured logging*: Preserves structured data in Event Log entries
 -  *Unicode support*: Full support for international characters and emoji
 -  *Platform safety*: Automatically restricts installation to Windows platforms
 -  *Zero dependencies*: No external dependencies for Deno and Bun


Installation
------------

This package is available on [JSR] and [npm]. You can install it for various
JavaScript runtimes and package managers:

~~~~ sh
deno add jsr:@logtape/windows-eventlog  # for Deno
npm  add     @logtape/windows-eventlog  # for npm
pnpm add     @logtape/windows-eventlog  # for pnpm
yarn add     @logtape/windows-eventlog  # for Yarn
bun  add     @logtape/windows-eventlog  # for Bun
~~~~

> [!NOTE]
> This package is only available for Windows platforms. The package installation
> is restricted to Windows (`"os": ["win32"]`) to prevent accidental usage on
> other platforms.


Usage
-----

The quickest way to get started is to use the `getWindowsEventLogSink()`
function with your application source name:

~~~~ typescript
import { configure } from "@logtape/logtape";
import { getWindowsEventLogSink } from "@logtape/windows-eventlog";

await configure({
  sinks: {
    eventlog: getWindowsEventLogSink({
      sourceName: "MyApplication",
    }),
  },
  loggers: [
    { category: [], sinks: ["eventlog"], lowestLevel: "info" },
  ],
});
~~~~

You can also customize the sink behavior with additional options:

~~~~ typescript
import { configure } from "@logtape/logtape";
import { getWindowsEventLogSink } from "@logtape/windows-eventlog";

await configure({
  sinks: {
    eventlog: getWindowsEventLogSink({
      sourceName: "MyApplication",
      eventIdMapping: {
        error: 1001,
        warning: 2001,
        info: 3001,
      },
    }),
  },
  loggers: [
    { category: [], sinks: ["eventlog"], lowestLevel: "info" },
  ],
});
~~~~

> [!NOTE]
> The Windows Event Log sink always writes to the `Application` log.
> This is the standard location for application events and does not require
> administrator privileges.


Runtime support
---------------

The Windows Event Log sink works across multiple JavaScript runtimes on Windows:

 -  *Deno*: Uses [Deno's native FFI] for optimal performance
 -  *Node.js*: Uses the [koffi] library for FFI bindings
 -  *Bun*: Uses [Bun's native FFI] for maximum performance

[Deno's native FFI]: https://docs.deno.com/runtime/fundamentals/ffi/
[koffi]: https://koffi.dev/
[Bun's native FFI]: https://bun.sh/docs/api/ffi


Viewing logs
------------

Once your application writes to the Windows Event Log, you can view the logs using:

 -  *Event Viewer* (*eventvwr.msc*)
 -  *PowerShell*: `Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='MyApplication'}`
 -  *Command Prompt*: `wevtutil qe Application /f:text /q:"*[System[Provider[@Name='MyApplication']]]"`


Docs
----

The docs of this package is available at
<https://logtape.org/manual/sinks#windows-event-log-sink>. For the API
references, see <https://jsr.io/@logtape/windows-eventlog>.
