# Templates and Preferences

<!-- help-source -->

## Create, open and save templates

The application starts with a blank Untitled template. Use **New Template** to create a new one, **Open Template** to load an existing one, and **Save Template** to save the current template.

## What is saved?

| Data | Storage |
| --- | --- |
| Template name, Tool Instances, Tool Setup, Workflow | Template |
| FG/BG Interaction and Data Buffer settings | Template (required even when disabled) |
| Chart definitions/settings | Optional; only with Save charts with template |
| External tool EXE paths | Local computer |
| Live Resources, VISA Backend and last-known device identity | Local computer |
| Language, appearance, Step Display Density | Local preferences |
| Simulation/Live mode, Last Run, Run ID and results | Temporary |
| Data Buffer contents and status | Temporary |
| Unsaved Charts, interactive zoom/pan | Temporary |
| Workflow Chart Options (Sampling, Preserve Significant Changes, Show Significant Change Markers, Fit Data) | Temporary |
| Loading/error state, dialogs, export destinations, Powers runtime authorization | Not saved in templates |

### Move a template to another computer

If you send a Template from computer A to computer B, your colleague receives the instances, instrument settings and workflow. They must configure the EXE paths and any Live Resources for their own computer. Templates do not carry measured data; export results separately.

### Older template compatibility

The current template requires explicit FG/BG Buffer settings even when disabled. Older templates missing the required settings are rejected; no migration or automatic defaults are provided.

## Language and appearance

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
