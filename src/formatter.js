/*global Typeset.linebreak, Hypher*/

/*!
 * Knuth and Plass line breaking algorithm in JavaScript
 *
 * Licensed under the new BSD License.
 * Copyright 2009-2010, Bram Stein
 * All rights reserved.
 */
Typeset.formatter = function (measureText, options) {
    const linebreak = Typeset.linebreak;
    const spaceDefaults = Typeset.formatter.defaults.space;
    const spaceOptions = options?.space ?? spaceDefaults;

    function splitWords(text) {
        return text.match(/\S+/g) || [];
    }

    const spaceWidth = measureText(' ');
    const spaceStretch = (spaceWidth * spaceOptions.width) / spaceOptions.stretch;
    const spaceShrink = (spaceWidth * spaceOptions.width) / spaceOptions.shrink;
    const h = new Hypher(Hypher.en);
    const hyphenWidth = measureText('-');
    const hyphenPenalty = 100;

    function pushWord(nodes, word) {
        const hyphenated = h.hyphenate(word);

        if (hyphenated.length > 1 && word.length > 4) {
            for (let partIndex = 0; partIndex < hyphenated.length; partIndex += 1) {
                const part = hyphenated[partIndex];
                nodes.push(linebreak.box(measureText(part), part));
                if (partIndex !== hyphenated.length - 1) {
                    nodes.push(linebreak.penalty(hyphenWidth, hyphenPenalty, 1));
                }
            }
        } else {
            nodes.push(linebreak.box(measureText(word), word));
        }
    }

    function pushWords(nodes, words, afterWord) {
        for (let index = 0; index < words.length; index += 1) {
            pushWord(nodes, words[index]);
            afterWord(nodes, index, words);
        }
    }

    return {
        center(text) {
            const nodes = [];

            // Although not specified in the Knuth and Plass whitepaper, this box is necessary
            // to keep the glue from disappearing.
            nodes.push(linebreak.box(0, ''));
            nodes.push(linebreak.glue(0, 12, 0));

            pushWords(nodes, splitWords(text), (nodes, index, words) => {
                if (index === words.length - 1) {
                    nodes.push(linebreak.glue(0, 12, 0));
                    nodes.push(linebreak.penalty(0, -linebreak.infinity, 0));
                } else {
                    nodes.push(linebreak.glue(0, 12, 0));
                    nodes.push(linebreak.penalty(0, 0, 0));
                    nodes.push(linebreak.glue(spaceWidth, -24, 0));
                    nodes.push(linebreak.box(0, ''));
                    nodes.push(linebreak.penalty(0, linebreak.infinity, 0));
                    nodes.push(linebreak.glue(0, 12, 0));
                }
            });

            return nodes;
        },
        justify(text) {
            const nodes = [];

            pushWords(nodes, splitWords(text), (nodes, index, words) => {
                if (index === words.length - 1) {
                    nodes.push(linebreak.glue(0, linebreak.infinity, 0));
                    nodes.push(linebreak.penalty(0, -linebreak.infinity, 1));
                } else {
                    nodes.push(linebreak.glue(spaceWidth, spaceStretch, spaceShrink));
                }
            });

            return nodes;
        },
        left(text) {
            const nodes = [];

            pushWords(nodes, splitWords(text), (nodes, index, words) => {
                if (index === words.length - 1) {
                    nodes.push(linebreak.glue(0, linebreak.infinity, 0));
                    nodes.push(linebreak.penalty(0, -linebreak.infinity, 1));
                } else {
                    nodes.push(linebreak.glue(0, 12, 0));
                    nodes.push(linebreak.penalty(0, 0, 0));
                    nodes.push(linebreak.glue(spaceWidth, -12, 0));
                }
            });

            return nodes;
        }
    };
};

Typeset.formatter.defaults = {
    space: {
        width: 3,
        stretch: 6,
        shrink: 9
    }
};
