import app from './app.ts'
import backgroundChartPanel from './backgroundChartPanel.ts'
import backgroundOutput from './backgroundOutput.ts'
import backgroundSetup from './backgroundSetup.ts'
import capability from './capability.ts'
import chartPanelView from './chartPanelView.ts'
import chartPlot from './chartPlot.ts'
import chartSettings from './chartSettings.ts'
import chartType from './chartType.ts'
import chartValidation from './chartValidation.ts'
import collapsible from './collapsible.ts'
import executionMode from './executionMode.ts'
import failureDetails from './failureDetails.ts'
import failurePresentation from './failurePresentation.ts'
import inputOperator from './inputOperator.ts'
import inputValueEditor from './inputValueEditor.ts'
import interactionEditor from './interactionEditor.ts'
import messages from './messages.ts'
import outputCharts from './outputCharts.ts'
import pageResultSummary from './pageResultSummary.ts'
import preferences from './preferences.ts'
import preflight from './preflight.ts'
import resultChart from './resultChart.ts'
import resultFields from './resultFields.ts'
import scopesActionEditor from './scopesActionEditor.ts'
import sequenceEditor from './sequenceEditor.ts'
import serialActionEditor from './serialActionEditor.ts'
import showMessageEditor from './showMessageEditor.ts'
import status from './status.ts'
import steps from './steps.ts'
import timeFormat from './timeFormat.ts'
import toolSetupEditor from './toolSetupEditor.ts'
import useSimulationSamples from './useSimulationSamples.ts'
import virtualizedOutputTable from './virtualizedOutputTable.ts'
import workflowCanvas from './workflowCanvas.ts'
import workflowRunSummary from './workflowRunSummary.ts'

export default {
  ...app,
  ...backgroundChartPanel,
  ...backgroundOutput,
  ...backgroundSetup,
  ...capability,
  ...chartPanelView,
  ...chartPlot,
  ...chartSettings,
  ...chartType,
  ...chartValidation,
  ...collapsible,
  ...executionMode,
  ...failureDetails,
  ...failurePresentation,
  ...inputOperator,
  ...inputValueEditor,
  ...interactionEditor,
  ...messages,
  ...outputCharts,
  ...pageResultSummary,
  ...preferences,
  ...preflight,
  ...resultChart,
  ...resultFields,
  ...scopesActionEditor,
  ...sequenceEditor,
  ...serialActionEditor,
  ...showMessageEditor,
  ...status,
  ...steps,
  ...timeFormat,
  ...toolSetupEditor,
  ...useSimulationSamples,
  ...virtualizedOutputTable,
  ...workflowCanvas,
  ...workflowRunSummary,
}
