/**
 * Task state machine.
 *
 * States:
 *   inbox              → human creates task
 *   pm_questioning     → PM wrote questions, waiting for human answers
 *   pm_active          → PM is writing BRD (automated)
 *   architect_active   → Architect writing tech plan
 *   dev_active         → Developer implementing
 *   qa_active          → QA testing (container running)
 *   tests_active       → Test writer writing automated tests
 *   review_active      → Code reviewer reviewing
 *   awaiting_acceptance→ All done, human reviews
 *   done               → Human accepted
 *   failed             → Max retries exceeded or blocked
 */

const MAX_QA_RETRIES     = 3
const MAX_REVIEW_RETRIES = 2

const AGENT_FOR_STATUS = {
  pm_active:        'pm',
  architect_active: 'architect',
  dev_active:       'developer',
  qa_active:        'qa',
  tests_active:     'tests',
  review_active:    'reviewer'
}

/**
 * Given current status + agent result, return next status.
 */
function nextStatus(currentStatus, agentResult, retryCount) {
  const { status } = agentResult   // 'done' | 'questions' | 'failed'

  switch (currentStatus) {
    case 'inbox':
      return 'pm_active'

    case 'pm_active':
      if (status === 'questions') return 'pm_questioning'
      return 'architect_active'

    case 'pm_questioning':
      // Human answered → re-run PM to write BRD
      return 'pm_active'

    case 'architect_active':
      if (status === 'failed') return 'failed'
      return 'dev_active'

    case 'dev_active':
      if (status === 'failed') return 'failed'
      return 'qa_active'

    case 'qa_active':
      if (status === 'done') return 'tests_active'
      // Bugs found → back to dev
      if (retryCount < MAX_QA_RETRIES) return 'dev_active'
      return 'failed'

    case 'tests_active':
      return 'review_active'

    case 'review_active':
      if (status === 'done') return 'awaiting_acceptance'
      if (retryCount < MAX_REVIEW_RETRIES) return 'dev_active'
      return 'awaiting_acceptance'  // let human decide after max retries

    default:
      return currentStatus
  }
}

function agentForStatus(status) {
  return AGENT_FOR_STATUS[status] || null
}

function isAutomated(status) {
  return Object.keys(AGENT_FOR_STATUS).includes(status)
}

function isHumanStep(status) {
  return ['inbox', 'pm_questioning', 'awaiting_acceptance', 'done', 'failed'].includes(status)
}

function needsEnvironment(status) {
  return status === 'qa_active'
}

module.exports = { nextStatus, agentForStatus, isAutomated, isHumanStep, needsEnvironment }
