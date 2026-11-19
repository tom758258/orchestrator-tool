# Powers Steps

<!-- help-source -->

#### Power Set Output

The Channel dropdown is shared by **Power Set Output**, **Power Output ON**, **Power Output OFF**, **Power Measure**, and the **Specific channel**
selection in **Power Protection Status**. It lists only channels confirmed by
the target instance's capabilities as **CH1**, **CH2**, etc. Simulation uses the
simulator channels; Live uses the model identified for the saved Resource in
Setup. Changing the target instance, Execution Mode, or Powers executable
updates the available channels.

Loading, a missing Live model, a failed capability query, or an empty channel
list displays a hint and disables fixed channel selection. Saved channels
outside the supported list remain visible as unsupported or unconfirmed and
are preserved when saving and reloading. Existing Channel bindings are shown
as **Bound channel (preserved)**. Selecting a supported fixed channel explicitly
replaces the saved channel or its binding; capabilities never change it automatically.

Add **Power Set Output** to set a channel's Voltage, Current Limit, or both.
Channel is required; at least one of the two setpoints must be selected. Use
**Set Voltage** and **Set Current Limit** to include or remove each setpoint;
unchecking leaves that instrument setting unchanged. The fields show **Voltage
(V)** and **Current Limit (A)**. Power Set Output allows
only numeric **Fixed value**, **Variable**, or **Calculation** setpoints.
Calculation operands allow only fixed numbers or variables, with Add, Subtract,
Multiply, or Divide. Previous step result, Elapsed time, Timestamp, and comparison
calculations are unavailable for setpoints. Templates enforce these restrictions.
Resolved variables must still be numeric or Powers action validation fails. **Current Limit** is the power supply output
current-limit setpoint, expressed in A, not a forced output current. This step
only configures the setpoints. Use **Power Output ON** separately to enable the output.

#### Power Measure

Add **Power Measure** to read the selected channel's actual Voltage (V) and
Current (A) once. It uses the fixed Channel dropdown without enabling the
output or changing setpoints. After it completes, later Output, Assert, and
Calculation steps can select **Voltage** or **Current** from its Step Output.
The numeric pointers are `/data/measurements/voltage` and
`/data/measurements/current`. It is foreground-only; readings do not create
a Result column unless you add an Output step.

#### Power Protection Status

Add **Power Protection Status** to read protection trip state without changing
instrument settings. Select **All** channels or **Specific channel** and choose
from the Channel dropdown. Switching from All to Specific selects the first
supported channel. If capabilities are unavailable or contain no channels,
Specific is unavailable and All is preserved; existing Specific values remain
preserved. The result offers **Protection Tripped**, **Over Voltage Tripped**, and
**Over Current Tripped**. Protection Tripped is true when either voltage or
current protection has tripped. Powers Tool validates actual model support.

To fail the Workflow after a trip, add an **Assert** after Power Protection
Status. Select **Previous step result → Protection Tripped** on the left,
`==` as the operator, and **Boolean → False** on the right. Status alone does
not stop the Workflow, clear protection, or modify the power supply.

For IF/ELSE, the three Protection Status result fields are Boolean: true means the corresponding protection has tripped, and false means it has not. Choose Boolean on the other side of the comparison; selecting a result does not change the other operand.

