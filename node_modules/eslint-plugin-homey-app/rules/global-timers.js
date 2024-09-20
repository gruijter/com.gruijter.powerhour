'use strict';

module.exports = {
  meta: {
    type: 'suggestion',
    messages: {
      globalTimer:
        'Call to global {{ functionName }}(). You need to manually clear this when the app is destroyed.',
      globalTimerFix: 'Consider using this.homey.{{ functionName }}() instead.',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();

    return {
      CallExpression(node) {
        const functionName = node.callee.name;

        if (functionName === 'setInterval' || functionName === 'setTimeout') {
          context.report({
            node,
            messageId: 'globalTimer',
            data: { functionName },
            suggest: [
              {
                messageId: 'globalTimerFix',
                data: { functionName },
                fix(fixer) {
                  const original = sourceCode.getText(node);
                  const fixed = `this.homey.${original}`;
                  return fixer.replaceText(node, fixed);
                },
              },
            ],
          });
        }
      },
    };
  },
};
