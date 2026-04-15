// Public re-exports for programmatic use
export {
  renderHeader,
  renderPreflightOk,
  renderPreflightError,
  renderTaskStart,
  renderTaskComplete,
  renderTaskError,
  renderWorkflowComplete,
  renderError,
  renderWarnings,
  renderValidationErrors,
  renderDryRunTask,
} from "./output/renderer.js";
export { formatCliError, printCliError } from "./output/errors.js";
