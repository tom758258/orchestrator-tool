# Workflow Editor

<!-- help-source -->

## Edit your workflow

| Area | Purpose |
| --- | --- |
| Steps | Choose a step to add |
| Sequence | See execution order, select and move steps |
| Properties | Set parameters for the selected step |
| Workflow summary | Validate, run, stop and view errors |

### Step categories and reference index

| Category | Steps |
| --- | --- |
| Workflow | For, While, If / Else, Set Variable, Output, Wait, Assert, Show Message, String Process, Byte Process, Array Process |
| Background Workflow | Worker ON / OFF, Capture ON / OFF |
| FG/BG Interaction | BG Command, Get Latest, Wait Next, Get Command Result, Get Buffer Data, Get Buffer Status |
| Meters | Meter Measure |
| Powers | Power Set Output, Power Output ON / OFF, Power Measure, Power Protection Status |
| Scopes | Channel Display, Channel Scale, Channel Offset, Horizontal Scale, Horizontal Position, Edge Trigger, Single Wait, Measure, Capture, Screenshot, AutoScale |
| Serial | Send, Send File, Receive, Query |

See the corresponding step references for purposes and limitations. Output creates a data column, not a power supply output.

### When categories are available

| Category | Unlock requirement |
| --- | --- |
| Workflow | Always available |
| Background Workflow | Background binding in Setup |
| FG/BG Interaction | Background binding and Enable FG/BG Interaction |
| Instrument category | Matching Tool Instance in the Template |

The **Steps** categories keep this fixed relative order: **Workflow**,
**Background Workflow**, **FG/BG Interaction**, **Meters**, **Powers**, **Scopes**,
**Serial**. Available categories appear first. Locked categories are moved to
**Unavailable categories (N)** at the bottom of the list. This group starts
collapsed; expand it to see each locked category and its existing reason. When
no categories are locked, the group is hidden. Workflow is always available.
Background Workflow requires a Background binding in Setup; FG/BG Interaction
also requires **Enable FG/BG Interaction** in the Workflow sidebar. Instrument
categories require a matching Tool Instance in the Template. Locked categories
cannot expand or be selected. Adding or removing bindings or instances updates
the grouping without deleting existing Steps. Live Resources, executable
configuration, capabilities, and Execution Mode do not affect these locks.

Click an available category header to expand or collapse it independently.
Expanded categories show **−**; collapsed categories show **+** and hide their
step buttons. Available categories start expanded when the app opens; changing
availability does not erase their individual expand/collapse choices. A successful
New or Open Template resets the unavailable group to collapsed. UI expansion
states are not saved in Templates. **Scopes File Output** remains a separate
panel with its own expand/collapse state and the same Scopes Instance lock.

### Edit and rename a step

Steps can be placed in the root workflow, loop bodies, or If branches. Use the step
properties area to edit the selected step. Use Validate when you want to
check the current Template before running; Simulation and Live also validate
the Template when the run starts, so pressing Validate first is useful but is
not a separate run prerequisite.
Use the pencil beside Step ID in Properties to rename a step. Press Enter or Save to apply; Escape or Cancel discards the edit. IDs must use lowercase letters, digits, and single hyphens between segments and be unique throughout the Workflow. Renaming also updates references to that step. Editing is unavailable while the Workflow is busy.

### Add a step

In **Steps**, hover over any available step type to see its short native
tooltip describing the action. Click a step type to select it; clicking does
not insert it. **Selected Step** and **Add Step** stay above the scrollable
categories. **Add Step** is disabled until a type is selected. Press it to
insert into the location shown by **ADDING STEP TO**. After insertion the
palette selection clears, while the inserted Workflow step remains selected
for editing. **Set Target to Root** switches the destination without inserting
a step. Creating or opening a Template also clears the palette selection.
Hover over a shortened step name to see its full name and description.

Alternatively, drag a Step type from **Steps** into **Sequence** to insert it at the
drop position, independently of the **ADDING STEP TO** target. Drop before or
after a Step, at the end of Root, or into an empty or populated IF **THEN** /
**ELSE**, FOR, or WHILE body. Dropping outside a valid destination does not add
a Step. After a successful drop, the new Step is selected in **Properties** and
the Palette selection clears. Drag-to-add is unavailable while editing is busy.

### Workflow controls

**Validate**, **Run Simulation / Run Live**, **Stop Workflow**, and active loop **Stop** controls
appear at the top-right of the Workflow summary, beside **Template** and
**Steps**. Validation, running, Stop, and run failure feedback appears below
these controls, above the Builder. Detailed run errors remain available there.
Controls wrap when the window is narrow. **Clear Workflow** stays in the
**Sequence** header.

### Display density and collapsing

The **Step Display Density** menu to the right of **Clear Workflow** offers
**Compact**, **Standard** (default), and **Comfortable**. The density preference is
stored locally and applies across Templates; it does not change Workflow data.

In **Sequence**, each **FOR**, **WHILE**, and **IF** step has its own expand/collapse
arrow. **IF** also lets you collapse **THEN** and **ELSE** independently.
**Expand All** and **Collapse All** appear below the Sequence heading. Collapsing
hides nested steps but keeps their count and any selection, validation, or run
failure indication visible. Switching tabs keeps the current view; creating or
opening a Template expands all steps. Expand a body before dragging into it;
**Add Step** reveals a collapsed destination after successful insertion.

### Error feedback after editing

Editing Workflow steps, execution settings in Tool Setup, or Background bindings
and setup immediately hides the previous run failure or Live startup error from
the Workflow summary. Pressing **Validate** also hides that feedback immediately,
even without edits. Validation shows its own result; **Valid** does not guarantee
that a run will succeed. A new failed run shows its own error and **Technical
details**. Selecting steps, switching tabs, and changing display options keep
the current error feedback.

These actions preserve Last Run's original status, diagnostics, Execution Results,
committed Output rows, Background datasets, and partial export. A failed Last Run
remains failed in **Output**. Live Preflight failures keep their separate feedback
and mean that the Live run has not started.

### Select and move steps

In **Sequence**, click a step to select it. **Ctrl+Click** adds or removes an
individual step; **Shift+Click** selects the range from the selection anchor.
Multi-selection stays within one sibling list: root steps or the body of one
For or While. Ctrl/Shift-clicking another list starts a new selection there.
**Properties** can edit only one step; multiple selected steps show their count.

Drag the handle beside a step to reorder it or move it between Root, For bodies,
and While bodies. Drop on a card's upper or lower half to insert before or after
it; drop in a body's blank area to append, including empty bodies. The insertion
line shows the destination. Use the blank area at the end of the Root list to
move steps back to Root. Dragging a selected step moves the whole selection,
including non-adjacent steps, in their original relative order. Moving a loop
keeps its whole body. IDs, parameters, bindings and references are preserved.
The editor prevents moving a control block into itself or a descendant and prevents If/For/While nesting beyond eight levels. It does not validate execution semantics during dragging.
The Sequence scrolls when dragging near its top or bottom edge.

**Up** / **Down** move the selection one position within its list; the operation
is disabled when any selected step reaches that boundary. The **Delete** button
on a selected step deletes the selection; on an unselected step it deletes only
that step. Deleting a loop also deletes its body.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+C | Copy selected steps |
| Ctrl+X | Cut into the application's internal clipboard |
| Ctrl+V | Paste after the last selected step, or at the end of Root if none is selected |
| Delete | Delete selection; no selection means no action |
| Ctrl+A | Select direct siblings of the active step, or Root steps; not nested bodies |

The first paste after Cut preserves IDs and internal references if there are no conflicts. Later or conflicting pastes use ID remapping and unique Output names; Output name and Page conflicts follow the existing paste rules. Pasted steps become the selection.

The internal clipboard lasts for this application session. Inputs, text areas,
selects and editable text keep their native shortcuts. While the Workflow is
busy, selection and Copy remain available, but dragging, Up/Down, Cut, Delete
and Paste are disabled.

### Validate and check references

**Validate**, **Run Simulation**, and **Run Live** use the same Core Template
validation. On failure, the overall error remains visible. When the error
reliably identifies a step, its card has a red border and warning icon; select
it to see the reason in Properties. Errors without a reliable step location
remain overall errors. Editing the Workflow clears old validation marks; only
the next Validate or Run checks again. Invalid Templates do not start workers.
Use Validate after moving steps to check references and scopes: a For variable
cannot be used outside its body unless a value already exists in that enclosing
scope. Ordinary variables created inside a loop are local to each iteration;
updates to inherited variables persist. Validation checks statically unavailable
variables, while value-dependent errors remain runtime checks.
