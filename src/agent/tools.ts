/**
 * The tool surface the discovery model drives.
 *
 * One design rule shapes all of it: every tool that touches a control takes a `ref`
 * from the current observation. There is no tool that accepts a CSS selector, an XPath
 * or a coordinate. The model is therefore structurally incapable of inventing a brittle
 * locator — the durable locator ladder is synthesised afterwards by the recorder, from
 * the accessibility descriptors we already hold for that ref.
 *
 * The second rule is that `finish` makes the model state the capability CONTRACT, not
 * just declare victory. A run that reached the goal but can't say what its inputs,
 * outputs and failure modes are has not produced a reusable capability.
 */

import type Anthropic from '@anthropic-ai/sdk';

export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'navigate',
    description:
      'Navigate to a URL. Blocked by policy if the URL is outside the configured allowlist.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to open.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click a control. Use the ref number from the current observation. After clicking, you ' +
      'will receive a fresh observation of the resulting page.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Element ref from the current observation.' },
        intent: {
          type: 'string',
          description:
            'One sentence describing WHY you are clicking this, written for a human reviewing ' +
            'the recorded capability later. E.g. "Submit the member lookup form".',
        },
      },
      required: ['ref', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description:
      'Type text into a text field. If the value is one that a caller would supply per ' +
      'invocation (a member number, an amount), declare it later as an input parameter in ' +
      '`finish` with this exact value as its `example`, and it will be parameterised.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer' },
        text: { type: 'string' },
        intent: { type: 'string', description: 'Why, in one sentence, for a human reviewer.' },
      },
      required: ['ref', 'text', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown by its value or visible label.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer' },
        value: { type: 'string' },
        intent: { type: 'string' },
      },
      required: ['ref', 'value', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract',
    description:
      'Read a value out of the page and record it as a declared output of this capability. ' +
      'Use this for the data the caller actually asked for. Supply a regex with one capture ' +
      'group if the value is embedded in surrounding text.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'The element containing the value.' },
        output_name: { type: 'string', description: 'camelCase name, e.g. savingsBalance.' },
        from: { type: 'string', enum: ['text', 'value'], description: 'Read element text or input value.' },
        pattern: {
          type: 'string',
          description:
            'Optional regex with one capture group, e.g. "\\\\$([\\\\d,\\\\.]+)" to pull 4,182.55 out of "$4,182.55".',
        },
        intent: { type: 'string' },
      },
      required: ['ref', 'output_name', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description:
      'Call this ONLY when the goal is complete and you can see the result on screen. You must ' +
      'define the full capability contract: what it is called, what it takes, what it returns, ' +
      'and which legitimate non-error answers it can produce.',
    input_schema: {
      type: 'object',
      properties: {
        capability_id: {
          type: 'string',
          description: 'Stable dotted id, e.g. "member.read-savings-balance".',
        },
        name: { type: 'string', description: 'Short human-readable name.' },
        description: {
          type: 'string',
          description: 'What this capability does, for a calling agent and a human reviewer.',
        },
        inputs: {
          type: 'array',
          description:
            'Parameters a caller supplies per invocation. Any value you typed that matches an ' +
            "input's `example` will be replaced with a placeholder in the recorded flow.",
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean'] },
              description: { type: 'string' },
              pattern: { type: 'string', description: 'Regex the value must satisfy, e.g. "^\\\\d{6}$".' },
              sensitivity: {
                type: 'string',
                enum: ['public', 'pii', 'secret'],
                description:
                  'Classify honestly. A member/account identifier is pii. Credentials are secret.',
              },
              example: {
                type: 'string',
                description: 'The exact value you typed during this run. Used to parameterise the flow.',
              },
            },
            required: ['name', 'type', 'description', 'sensitivity', 'example'],
            additionalProperties: false,
          },
        },
        outputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Must match an output_name you used in `extract`.' },
              type: { type: 'string', enum: ['string', 'number', 'money', 'boolean'] },
              description: { type: 'string' },
              sensitivity: { type: 'string', enum: ['public', 'pii', 'secret'] },
            },
            required: ['name', 'type', 'description', 'sensitivity'],
            additionalProperties: false,
          },
        },
        outcomes: {
          type: 'array',
          description:
            'Legitimate non-error answers this capability can return INSTEAD of its normal ' +
            'result — e.g. the member number does not exist. These are results the caller ' +
            'needs, NOT failures. Describe the on-screen text that indicates each one.\n\n' +
            'Do NOT declare an outcome for the success case. Success is not an outcome — it ' +
            'is the absence of one. An outcome whose text appears on the successful end ' +
            'screen would stop replay before it could read the data you were asked for.',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND.' },
              description: { type: 'string' },
              detect_text: {
                type: 'string',
                description: 'Exact on-screen text that indicates this outcome.',
              },
            },
            required: ['code', 'description', 'detect_text'],
            additionalProperties: false,
          },
        },
        success_text: {
          type: 'string',
          description:
            'Exact text visible on screen right now that proves the goal was reached. This ' +
            'becomes the capability success checkpoint, so choose something specific to the ' +
            'end state and not present earlier in the flow.',
        },
      },
      required: ['capability_id', 'name', 'description', 'inputs', 'outputs', 'outcomes', 'success_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'stuck',
    description:
      'Call this if you cannot make progress: the goal appears impossible, you are looping, or ' +
      'proceeding would require an action you are not permitted to take. Do not guess.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export const SYSTEM_PROMPT = `You are an automation engineer's agent, working inside a local development sandbox.

The application you are driving is a mock back-office console running on localhost. It was written for this project to stand in for a real one: the member records are invented fixtures, the sign-on form accepts any credentials, and no real system, customer or money is reachable from it. Your job is to work out how a task is performed in this UI so the flow can be recorded once and replayed thousands of times without you.

You perceive the screen through an accessibility index. Each line is:

    [ref] role "accessible name"   (frame: name)

Act on controls by their ref number. You cannot use CSS selectors, XPath or coordinates — refs are the only way to address a control, and refs are only valid for the observation you were just shown.

How to work:

- Read the observation before acting. The app is server-rendered and every click reloads the page, so refs change after every action.
- This is a frameset. Content lives in a child frame; the index tells you which.
- Controls are labelled from adjacent table cells, because the markup has no real labels. A field named "Member Number" is the input sitting next to that text.
- Take one action at a time and check the result.
- When you reach the goal, use \`extract\` to capture the values that were actually asked for, then call \`finish\`.

What you are really producing is a reusable capability, not just a completed task. So when you call \`finish\`:

- Parameterise correctly. Any value that would differ per invocation (a member number) is an input, with the value you typed as its \`example\`. Values that are part of the flow itself (a menu name) are not inputs.
- Classify sensitivity honestly — this is regulated financial data. Account and member identifiers are \`pii\`; credentials are \`secret\`.
- Declare business outcomes. Think about the legitimate answers other than success: what does this screen show when the record does not exist? Those are results the caller needs, not crashes. Give the exact on-screen text that identifies each.
- Choose \`success_text\` that is specific to the final screen and does not appear earlier in the flow.

Some actions may be refused by the safety policy. That is expected. If an irreversible action is blocked, do not try to work around it — call \`stuck\` and explain.`;
