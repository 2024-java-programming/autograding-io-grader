const {execSync} = require('child_process')
const core = require('@actions/core')

const env = {
  PATH: process.env.PATH,
  FORCE_COLOR: 'true',
  DOTNET_CLI_HOME: '/tmp',
  DOTNET_NOLOGO: 'true',
  HOME: process.env.HOME,
}

function getInputs() {
  const testName = core.getInput('test-name', {
    required: true,
  })
  const setupCommand = core.getInput('setup-command')
  const command = core.getInput('command', {
    required: true,
  })
  const input = core.getInput('input').trim()
  const expectedOutput = core.getInput('expected-output')
  const comparisonMethod = core.getInput('comparison-method')
  const timeout = parseFloat(core.getInput('timeout') || 10) * 60000 // Convert to minutes

  const passScore = parseInt(core.getInput('pass-score') || 0)
  const maxScore = parseInt(core.getInput('max-score') || 0)

  if (!!comparisonMethod && !['exact', 'contains', 'regex'].includes(comparisonMethod)) {
    throw new Error(`Invalid comparison method: ${comparisonMethod}`)
  }

  return {
    testName,
    setupCommand,
    command,
    input,
    expectedOutput,
    comparisonMethod,
    timeout,
    passScore: passScore > 0 ? passScore : maxScore * 0.8,
    maxScore,
  }
}

function parseGradleTestResults(testResults) {
  const tests = {};

  testResults.split('\n').forEach((line) => {
    const trimmedLine = line.trim();

    const match = trimmedLine.match(/(.+)\s+(PASSED|FAILED)/);
    if (match) {
      const hierarchy = match[1].split(/\s+>\s+/);
      const status = match[2];
      const isPassed = status === 'PASSED';

      let currentLevel = tests;

      hierarchy.forEach((level, index) => {
        if (index === hierarchy.length - 1) {
          currentLevel[level] = isPassed;
        } else {
          if (!currentLevel[level]) {
            currentLevel[level] = {};
          }
          currentLevel = currentLevel[level];
        }
      });
    }
  });

  return tests;
}

function executeTest(command, input, timeout) {
  try {
    const output = execSync(command, {
      input,
      timeout,
      env,
    })
      .toString()
      .trim()
    return {
      output,
    }
  } catch (e) {
    return {
      output: e.stdout ? e.stdout.toString().trim() : '',
      error: e.message.includes('ETIMEDOUT') ? 'Command was killed due to timeout' : e.message,
    };
  }
}

function compareOutput(output, expected, method) {
  switch (method) {
    case 'exact':
      return output === expected
    case 'contains':
      return output.includes(expected)
    case 'regex': {
      const regex = new RegExp(expected)
      return regex.test(output)
    }
    default:
      throw new Error(`Invalid comparison method: ${method}`)
  }
}

function run() {
  let inputs = {}

  try {
    inputs = getInputs()

    if (inputs.setupCommand) {
      execSync(inputs.setupCommand, {
        timeout: inputs.timeout,
        stdio: 'inherit',
        env,
      })
    }

    const startTime = new Date()
    const {output, error} = executeTest(inputs.command, inputs.input, inputs.timeout)
    const endTime = new Date()

    console.log(output, error);

    let status = 'pass'
    let message = null
    let maxScore = inputs.maxScore;
    let passScore = inputs.passScore;
    let score = inputs.maxScore

    const parsedResults = parseGradleTestResults(output);
    console.dir(parsedResults);

    let taskCount = 0;
    let taskPassed = 0;

    function countPassedTests(node) {
      for (let key in node) {
        const value = node[key];
        switch (typeof value) {
          case 'object':
            countPassedTests(value);
            break;
          case 'boolean':
            taskCount++;
            taskPassed += value ? 1 : 0;
            break;
        }
      }
    }

    countPassedTests(parsedResults);

    if (taskCount > 0) {
      console.log(`Collected ${taskCount} tasks, ${taskPassed} passed.`);

      if (maxScore === 0) { // Lazy case, full auto
        maxScore = taskCount;
        passScore = taskCount * 0.8;
        score = taskPassed;
      } else {
        score = (taskPassed / taskCount) * maxScore;
      }

      if (score < passScore) {
        status = 'fail'
        message = `You need earn more score.`
      }
    } else {
      console.log(`No task found, fallback to io handling.`);

      if (error) {
        status = 'error'
        message = error
        score = 0
      } else if (!compareOutput(output, inputs.expectedOutput, inputs.comparisonMethod)) {
        status = 'fail'
        message = `Output does not match expected: ${inputs.expectedOutput} Got: ${output}`
        score = 0
      }
    }

    const result = {
      version: 1,
      status,
      max_score: maxScore,
      tests: [
        {
          name: inputs.testName,
          status,
          message,
          test_code: `${inputs.command} <stdin>${inputs.input}`,
          filename: '',
          line_no: 0,
          execution_time: `${(endTime - startTime) / 1000}s`,
          score,
        },
      ],
    }

    console.log(result)
    core.setOutput('result', btoa(JSON.stringify(result)))
  } catch (error) {
    const result = {
      version: 1,
      status: 'error',
      tests: [
        {
          name: inputs.testName || 'Unknown Test',
          status: 'error',
          message: error.message,
          test_code: `${inputs.command || 'Unknown Command'} <stdin>${inputs.input || ''}`,
          filename: '',
          line_no: 0,
          execution_time: 0,
        },
      ],
    }

    core.setOutput('result', btoa(JSON.stringify(result)))
  }
}

function btoa(str) {
  return Buffer.from(str).toString('base64')
}

run()
