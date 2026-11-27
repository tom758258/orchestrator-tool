# Serial Background RX and Actions

<!-- help-source -->

## Serial communication basics

TX means transmit, RX means receive. ### UART and TCP

| Transport | Live connection |
| --- | --- |
| UART | COM Port and serial settings |
| TCP Client | Host, Port and TCP timeout; no TCP discovery |

Use Save Resource for the local connection address.

Serial supports UART (COM Port) and raw TCP Client. It does not decode device protocols or assemble RX events into complete packets.

| Mode | Purpose |
| --- | --- |
| Foreground | Run Send, Send File, Receive or Query in sequence |
| Background | Continuous RX, with Capture, Monitor or interaction steps |

## Background RX and communication setup

Register `serial-tool.exe` in Tools. In Setup, add a Serial Tool Instance, set the serial line parameters, and select Enable Background Streaming. Background Simulation uses Serial Tool's `periodic-rx-v1` to generate RX without TX (approximately one 4-byte counter every 100 ms). Foreground Simulation continues to use `loopback-v1`. Live uses a saved COM Port or TCP endpoint and requires explicit confirmation.

Serial supports UART (COM Port) and raw TCP Client in the same Tool Instance. Choose Transport in **Communication Setup**, which starts expanded. Use **− / +** to hide or show Transport and its UART or TCP settings; Background Streaming and Live Device stay visible. UART and TCP timeout settings are both retained in the Template when switching. For TCP Live, enter TCP Host and TCP Port under Live Device and Save Resource. COM ports and TCP endpoints are stored locally, not in Templates. TCP Simulation needs no host or device port, and TCP has no List Ports discovery.

### Start receiving, capture and inspect

Worker ON and Worker OFF control the continuous RX source. Capture ON and Capture OFF create separate Datasets without stopping the source. Each RX event produces one Output Data row containing all bytes received in that event; read boundaries are not protocol frames. The optional RX-only Live Monitor continues while Capture is OFF.

Serial RX Live Monitor keeps the Hex/Text received-data pane at a fixed height with its own scrollbar. Incoming data follows the bottom until you scroll up to inspect buffered bytes; scrolling back to the bottom resumes automatic following. Switching Hex/Text returns to the latest data. This is a bounded Monitor view, not a substitute for Capture.

Choose Hex Bytes or Text (UTF-8) for display without modifying recorded raw bytes. Serial Background manual export supports CSV, XLSX and BIN. BIN writes only raw received bytes, in order, with no headers, delimiters or timestamps; it cannot export numeric Meters or Scopes Datasets. Streaming Background CSV remains optional and accepts a Serial display format.

Serial does not offer numeric Charts. Worker shutdown validates stream termination, summary, EOF and exit status. Serial data quality remains unknown without stronger loss evidence; actual Worker and CSV errors still fail the run.

The Steps palette groups Background Worker ON/OFF and Background Capture ON/OFF in Background Workflow. The category is locked until the Template has at least one Background binding; unlocked categories initially expand and can be collapsed without deleting existing steps.

## Foreground communication steps

| Step | Purpose |
| --- | --- |
| Send | Send UTF-8 text or a single byte |
| Send File | Send unchanged file contents |
| Receive | Receive without sending |
| Query | Send, then receive |

Example: use UART Simulation with loopback-v1, Query TX Text OK, and RX Fixed Length of 2 bytes. Expect the same text if RX Text is enabled. This is simulated data, not a real MCU reply.

Serial Foreground has four actions: Serial Send, Serial Send File, Serial Receive and Serial Query. These use an ordinary non-streaming Serial Worker. A Serial Tool Instance cannot be used for both Foreground and Background. The original Serial Background RX-only capture and monitoring are unchanged.

### TX format

Send and Query TX support Text (UTF-8 string) and Single Byte (Integer Input). In Single Byte mode, a non-negative integer sends only its lowest eight bits. For example 4660 sends the single byte 34 in Single Byte mode. Fixed fractional Single Byte values fail validation. Dynamic numeric Single Byte values are truncated toward zero before TX; negative results, invalid types and out-of-range values fail the consuming Step without sending. Fixed values, Variables and earlier Step Outputs can be selected. To build a string Variable, use Set Variable with the String fixed-value type. Text does not interpret a hexadecimal sequence as binary bytes.

### RX completion modes

| Mode | Completion condition | Step |
| --- | --- | --- |
| Single Read | One underlying read | Receive |
| Until Delimiter | Delimiter received | Receive / Query |
| Fixed Length | Expected byte count reached | Receive / Query |
| Idle Gap | Silence after receiving data | Receive / Query |

RX Delimiter is independent of TX Format and supports multi-byte Text or Hex in Until Delimiter mode. Text recognizes backslash-r, backslash-n and escaped backslash. Receive sends no TX; Query sends TX before RX. Existing Receive Templates default to Single Read, and existing Query Templates default to Until Delimiter.

Receive supports Single Read (one underlying read), Until Delimiter (including the delimiter), Fixed Length (accumulate exactly Expected RX Bytes), and Idle Gap (complete after an RX silence interval). Query offers Delimiter, Fixed Length and Idle Gap, not Single Read. Expected RX Bytes and Idle Gap (ms) are required positive integers and initially blank when selecting those modes. Fixed Length uses Expected RX Bytes as both target and bound. Other modes use Max RX Bytes (1 through 1048576, default 1024), which is a limit, not a required count. Exceeding this limit before Delimiter or Idle Gap completes fails the Step.

### Received result

A completed read retains raw `/rx_hex` (Hex String), `/rx_bytes` (Number), `/outcome = completed` and `/timed_out = false`. When **Enable RX Text (UTF-8)** is checked, the Step also returns `/rx_text` (String or null), with the delimiter included. Invalid UTF-8 produces null without changing RX success; `/rx_hex` and `/rx_bytes` stay available. IF/ELSE, Assert and Set Variable can use the result pointers. Workflow does not automatically parse individual binary bytes.

### Timeout, partial data and errors

Receive/Query use the UART `timeout_ms` or TCP `io_timeout_ms` configured in Serial Setup. Idle Gap uses Read Timeout to await the first byte, then independently waits the configured idle interval after the latest RX. Delimiter and Fixed Length continue until their conditions are satisfied or a read timeout occurs; there is no separate overall RX timeout. A confirmed Read Timeout produces `/outcome = timeout`, `/timed_out = true`, `/partial_rx_hex` and `/partial_rx_bytes` when **Fail on Read Timeout** is unchecked. When UTF-8 output is enabled, it additionally returns `/partial_rx_text` (String or null). Checking Fail on Read Timeout fails the Workflow Step instead. A timeout result does not establish a complete reply or a passed MCU test.

For ordinary Worker Receive/Query, Read Timeout and ReadLimitExceeded consume only the already reported partial RX from the Session buffer, retaining any unreported trailing bytes. No OS/device RX queue is flushed; late data from a previous operation may be read by a later Receive/Query. The user must verify subsequent RX validity. ReadLimitExceeded, disconnection, other I/O errors, Worker failure, and action deadline expiry still fail the Step. Text TX requires a String; Single Byte TX requires a Number and sends only the low byte. RX Hex Strings cannot be sent as raw multi-byte TX.

### Send File paths and limits

Serial Send File stores an absolute worker-local file path in the Template. Missing files generate a nonblocking warning on Template load; invalid or missing files block Run before any Worker starts. A file can still disappear during execution; runtime errors then fail the Step. The Serial Worker command run-sequence, Background Query and Workflow raw-byte FIFO are not available as Orchestrator actions.

## Send / Send File while background RX runs

Enable **FG/BG Interaction**, add **Worker ON**, then add a **BG Command** for
the Serial Background. Select **Send** or **Send File**. Text, Single Byte, TX Data Source,
Calculation and file selection use the same rules as Serial Foreground. Send File
is checked before any Worker starts, including when nested in a Loop or IF.
Send and Send File use the same Worker and COM/TCP session while RX continues.
Capture may stay OFF; enable it to retain RX data.

Add **Get Command Result** and select the source BG Command. It returns the
complete native `job_finished` event: use `/result/tx_bytes` for Send or
`/result/bytes_written` for Send File. BG Command itself returns no data.
A status snapshot can confirm TX completion, but Get fails at its deadline if the
native event is missing. Completion does not mean the device replied or executed
the transmitted command; Get Latest and Wait Next still return independent RX.

Uncertain dispatch is never retried. If a Worker that attempted BG TX cannot be
confirmed OFF, the application blocks reuse of the same COM/TCP endpoint by
Foreground or Background. Verify the external Tool has safely stopped before
restarting the application. Pure RX-only operation keeps its existing behavior.
There is no Background Query, automatic TX/RX pairing or recovery screen.

With FG/BG Data Buffer enabled, Get Buffer Data returns an Array of complete RX events, not a raw-byte FIFO or packet reassembly. See [Background Interaction Steps](background.md) for capacity and overflow rules.
