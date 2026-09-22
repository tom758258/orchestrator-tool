# External Tool Boundary

Orchestrator Tool coordinates independent external programs. It owns shared
workflow, process, configuration, and compatibility infrastructure; it does
not become the instrument-control implementation for those programs.

## Tool Type and Tool Instance

**Tool Type** identifies an external program, such as meters, powers, scopes,
or wavegen. A Tool Type owns the executable identity and the type-level
manifest/Worker compatibility check.

**Tool Instance** is a logical member of a Template, identified by a unique
Tool Instance ID such as meters-1 or powers-1. A Tool Instance owns setup data
and is the target of Workflow Tool Actions. Multiple instances of one Tool
Type can have independent setup and Live Resource bindings while sharing the
same executable path.

Examples:

- A Powers-only Template can use powers-1.
- A Template with Powers and Scopes can use powers-1 and scopes-1.
- Two Meters instances can use meters-1 and meters-2, both with tool type
  meters but independent setup, Live Resource, and Worker sessions.

The Template stores logical tool identity and Tool Instance IDs. It does not
store machine-specific executable paths or physical resources.

## Executable path ownership

Executable paths are configured once per Tool Type, not once per Tool
Instance. Core reads a caller-selected local configuration file. The relevant
shape is:

    [tools]
    meters = "D:/tools/meters-tool.exe"
    powers = "D:/tools/powers-tool.exe"

    [live_resources]
    meters-1 = "USB0::VENDOR::METER_SERIAL::INSTR"
    powers-1 = "USB0::VENDOR::POWER_SERIAL::INSTR"

Only explicitly configured paths are used. There is no default location,
application-directory search, or executable auto-discovery. A relative path is
resolved relative to the directory containing the configuration file.
Unconfigured, missing, and non-file paths remain diagnostic states rather than
being silently replaced by another path.

Desktop exposes the same settings in its local application configuration. The
current configuration is a single orchestrator.toml under the OS/Tauri
application configuration directory. It stores type-level executable paths,
instance-level Live Resource bindings, and optional last-known resource
identity metadata. A missing configuration file leaves tools unconfigured.
Changing or clearing a path refreshes status; a newly selected path is
retained only after manifest identity and Worker compatibility validation
succeeds. Tool Status, Run Simulation, and Run Live use this same local
configuration.

External tool distributions remain outside this repository. In particular,
the orchestrator does not inspect or rearrange a PyInstaller onedir
distribution, does not copy its _internal directory, and does not bundle the
external executable. A user selects the executable from its complete
distribution while preserving that distribution's relative layout.

## Live Resource ownership

Live Resources are opaque, instance-level bindings stored only in local
configuration. They are not part of a Template and are not resolved as paths,
scanned for fallback values, or inferred from a Workflow. The configuration
may also retain last-known manufacturer, model, serial, and raw identity
presentation metadata keyed by Tool Instance ID.

Before a Live run, preparation requires a non-empty resource for each
referenced instance, rejects duplicate resource bindings, and confirms the
current instance ID, Tool Type, and resource. Simulation does not require Live
Resources. The selected execution mode is run state, not Template data.

When a Meters DC Current setup selects the 10 A Current Terminal, the Live
confirmation also asks the operator to confirm the physical connection.
Tool Setup coverage remains primarily simulation-based; specific hardware
models and setup combinations remain subject to validation by the
corresponding external instrument tool.

## Manifest and Worker compatibility boundary

Before starting a supported external Worker, Core probes the selected
executable with its manifest command and:

- validates the manifest event identity;
- validates manifest schema version 2;
- validates the declared Tool Type ID;
- reads the tool version and Worker protocol metadata; and
- validates overlap between the declared Worker protocol schema versions and
  the orchestrator's supported Worker schema version 2.

Worker startup then validates the Worker Ready information and exposes the
status, command, and stop endpoints through the generic Worker session. Core
owns process lifetime, event transport, bounded shutdown, and cleanup. The
external Worker owns its tool-specific command semantics and instrument
interaction.

## Responsibility boundary

The orchestrator must not duplicate external-tool VISA, SCPI, model,
instrument-capability, or instrument-safety logic. External tools remain
responsible for their supported models, numeric limits, setup interpretation,
instrument communication, and tool-specific safety behavior.

Core may validate the shape and consistency of setup data needed to build a
launch request. Its adapters translate that setup into the external tool's
existing launch and Worker requests, but do not maintain a second capability
database. Unsupported or evolving tool contracts must be reported rather than
guessed.

Scopes and Wavegen may be represented as independent Tool Instances, but
their runtime actions are not currently supported by the orchestrator.
Additional adapters, serial-tool handling, manifest-driven UI, plugin systems,
and setup registries are outside this boundary until a concrete requirement
exists.

## Powers live cleanup

Powers output safety remains a shared responsibility with an explicit
boundary. The external Powers tool performs its own instrument-specific
behavior; the orchestrator guarantees the run-level cleanup sequence:

1. A Live run authorizes output writes through the existing short-lived
   Desktop runtime configuration setting
   settings.allow_output_writes=true and the runtime request field
   arguments.confirm_output=true for output-affecting requests.
2. Every started Powers instance receives a bounded safe-off request before
   its Worker is shut down, including after workflow failure or a later Worker
   startup failure.
3. An explicit Powers `output-off` Tool Action does not replace the run-level
   cleanup.
4. Cleanup is best-effort and its failure makes the run fail while preserving
   the original workflow failure when one exists. Worker shutdown is still
   attempted.
5. The temporary authorization support file is removed best-effort after the
   run.

Simulation does not perform this additional Live safe-off sequence. This
boundary does not move Powers safety logic into Core; it defines when Core
requests the external tool's cleanup operation.

Meters capacity is calculated independently for each Tool Instance. Standard
Software mode uses the existing finite measurement bound and reserves one
extra max-samples slot until orchestrator shutdown; Live measurement inside an
Unlimited While omits max-samples, while Simulation requires a finite limit.

Software Custom is planned differently: the orchestrator derives an exact
maximum Trigger Count from the Workflow, passes trigger-count and sample-count
to meters-tool, and rejects a reachable Unlimited While. Trigger Count may not
exceed 1,000,000, and run preparation checked-multiplies Trigger Count by
sample-count to detect arithmetic overflow. Buffer capacity, supported model
memory, and the meaning of allow-buffer-overflow-risk remain owned and
validated by meters-tool rather than duplicated in the orchestrator.
