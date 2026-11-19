# Workflow Editor

<!-- help-source -->

## 6. Workflow Editor

The Workflow editor builds an ordered sequence of steps. The current step
types are:

- **Assert** — check a condition and fail the workflow if it is not true.
- **Set Variable** — create or update a workflow variable.
- **Output** — publish a value as a final workflow result column. It does not
  control a Powers output.
- **Wait** — wait for a specified duration.
- **Tool Action** — invoke an action on a configured Tool Instance, such as a
  Powers set or output action or a Meters measurement.
- **For** — repeat a body over an exact decimal range.
- **While** — repeat a body while a condition remains true.
- **If / Else** — run either THEN or ELSE once based on a comparison; ELSE may be empty.

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

Steps can be placed in the root workflow, loop bodies, or If branches. Use the step
properties area to edit the selected step. Use Validate when you want to
check the current Template before running; Simulation and Live also validate
the Template when the run starts, so pressing Validate first is useful but is
not a separate run prerequisite.
Use the pencil beside Step ID in Properties to rename a step. Press Enter or Save to apply; Escape or Cancel discards the edit. IDs must use lowercase letters, digits, and single hyphens between segments and be unique throughout the Workflow. Renaming also updates references to that step. Editing is unavailable while the Workflow is busy.

In **Steps**, hover over any available step type to see its short native
tooltip describing the action. Click a step type to select it; clicking does
not insert it. **Selected Step** and **Add Step** stay above the scrollable
categories. **Add Step** is disabled until a type is selected. Press it to
insert into the location shown by **ADDING STEP TO**. After insertion the
palette selection clears, while the inserted Workflow step remains selected
for editing. **Set Target to Root** switches the destination without inserting
a step. Creating or opening a Template also clears the palette selection.
All Step Palette buttons use a consistent single-line height. Long labels are shortened or truncated; their native tooltip preserves the full name and action description.

Alternatively, drag a Step type from **Steps** into **Sequence** to insert it at the
drop position, independently of the **ADDING STEP TO** target. Drop before or
after a Step, at the end of Root, or into an empty or populated IF **THEN** /
**ELSE**, FOR, or WHILE body. Dropping outside a valid destination does not add
a Step. After a successful drop, the new Step is selected in **Properties** and
the Palette selection clears. Drag-to-add is unavailable while editing is busy.

**Validate**, **Run Simulation / Run Live**, **Stop Workflow**, and active loop **Stop** controls
appear at the top-right of the Workflow summary, beside **Template** and
**Steps**. Validation, running, Stop, and run failure feedback appears below
these controls, above the Builder. Detailed run errors remain available there.
Controls wrap when the window is narrow. **Clear Workflow** stays in the
**Sequence** header.

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
The editor prevents moving a loop into itself or a descendant and prevents loop
depth beyond five. It does not validate execution semantics during dragging.
The Sequence scrolls when dragging near its top or bottom edge.

**Up** / **Down** move the selection one position within its list; the operation
is disabled when any selected step reaches that boundary. The **Delete** button
on a selected step deletes the selection; on an unselected step it deletes only
that step. Deleting a loop also deletes its body.

With focus in the Workflow editor:

- **Ctrl+C** copies the selected steps.
- **Ctrl+X** cuts the selected steps to the application's internal clipboard.
  The first paste preserves original IDs and internal references when IDs do not
  conflict. Later pastes, or a conflicting first paste, use Copy/Paste ID remapping
  and unique Output names. Output name or Page conflicts follow existing Paste rules.
- **Ctrl+V** pastes after the last selected step, or at the Root end when none is
  selected. The pasted steps become the new selection.
- **Delete** deletes the current selection; without a selection it does nothing.
- **Ctrl+A** selects the direct siblings of the active step, or Root steps if
  nothing is selected. It does not also select steps inside nested loop bodies.

The internal clipboard lasts for this application session. Inputs, text areas,
selects and editable text keep their native shortcuts. While the Workflow is
busy, selection and Copy remain available, but dragging, Up/Down, Cut, Delete
and Paste are disabled.

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

