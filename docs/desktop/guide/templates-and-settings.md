# Templates and Preferences

<!-- help-source -->

## 12. Templates and local machine settings

When the application starts, it creates a blank `Untitled` draft. There is no
separate `New` button in the current UI.

- **Open Template** loads an existing Template.
- **Save Template** writes the current Template.

A Template contains:

- Template name
- Tool Instances
- Tool setup
- Workflow
- Optional saved Chart definitions/settings, only when **Save charts with
  template** is enabled

A Template does not contain:

- executable paths;
- Live Resources or last-known resource identity;
- Simulation/Live mode;
- Last Run, Run IDs, or committed results;
- session-only Chart state that was not selected for saving;
- the current interactive zoom/pan viewport;
- Workflow Chart Options (Sampling, Preserve Significant Changes, Show
  Significant Change Markers, and Fit Data);
- loading/error UI state, dialog state, or export destinations/paths; or
- runtime Powers authorization.

This separation keeps Templates portable while keeping executable paths,
resources, and other machine/runtime state local to the Desktop installation.

## 13. Language and appearance

The globe button near **Appearance** shows **English** or **繁體中文**. Click it
once to switch the entire Desktop immediately without losing your edits, run, or
results. Your choice is remembered on this computer. On first launch, Traditional
Chinese WebView languages (`zh-TW` or `zh-Hant`) select Traditional Chinese;
other languages use English. Language and appearance are independent preferences
and are not saved in Templates or exported data. Names and values you enter,
technical identifiers, and original diagnostic details retain their contents.

**Help** opens the offline guide in the current Desktop language. After changing
language or appearance, click **Help** again to update its existing window.
The window title follows the selected language as well.
The guide retains its chapter navigation and has no separate language selector.

The **Appearance** control supports **System**, **Light**, and **Dark**. The
theme choice is a Desktop preference. It is not part of the Template
contract.

