# Configure External Tools

<!-- help-source -->

## 4. Configure external Tools

Executable paths belong to a Tool Type. They are shared by all Tool Instances
of that type; an individual Tool Instance does not store its own executable
path.

In **Tools**, select an unconfigured Tool Type under **Select tool to add**, choose
**Add Tool**, and select the actual executable supplied by the external tool
distribution. Desktop validates the executable's manifest
and Worker compatibility for the expected Tool Type before saving the path. A
path with the wrong Tool ID or incompatible Worker is rejected, and an
existing valid path is not replaced by the invalid selection. Canceling the
picker leaves configuration unchanged. Use **Change Path...** on a Tool card
to replace its path, or **Remove Tool** to remove only its local executable
configuration. Removing a Tool does not change Template instances or Workflow
steps; the Tool Type returns to the Add candidates.

Each External Tools card starts collapsed, with its Tool name and executable
status visible. Use **+ / −** to show or hide details and Change Path / Remove
Tool actions independently. Refresh and tab changes preserve the card's state.

Cards show only Tool Types with configured executable paths, including paths
that are **Missing**, **Not a file**, or have compatibility or manifest errors.
Unconfigured Tool Types appear in the Add candidates. If none are configured,
Tools shows **No external tools configured.**; if all are configured, Add is
disabled. Cards report availability, compatibility, and an explanation when
one is available. Desktop does not search `PATH`, the
Windows registry, or arbitrary folders, and does not silently fall back to a
different executable.

If an external tool is distributed by PyInstaller in `onedir` form, select
the real executable inside that distribution. Orchestrator Tool does not move
or copy the executable or its `_internal` directory.

