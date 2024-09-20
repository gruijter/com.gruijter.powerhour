'use strict';

module.exports = {
  meta: {
    type: 'suggestion',
    messages: {
      unexpected: 'Unexpected console statement.',
      homeyLogFix: 'Consider using this.{{ propertyName }}() instead.',
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();

    return {
      MemberExpression(node) {
        const objectName = node.object.name;
        const propertyName = node.property.name;

        if (objectName === 'console' && ['error', 'log'].includes(propertyName)) {
          context.report({
            node,
            messageId: 'unexpected',
            suggest: [
              {
                messageId: 'homeyLogFix',
                data: { propertyName },
                fix(fixer) {
                  const original = sourceCode.getText(node.property);
                  const fixed = `this.${original}`;
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
