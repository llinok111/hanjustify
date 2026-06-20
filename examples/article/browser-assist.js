jQuery(function ($) {
	var ruler = $('<div class="example"></div>').css({
			visibility: 'hidden',
			position: 'absolute',
			top: '-8000px',
			width: 'auto',
			display: 'inline',
			left: '-8000px'
		}),
		format,
		lineWidth;

	$('#browser-assist').parent().append(ruler);
	ruler.css('font', $('#browser-assist').css('font'));

	format = Typeset.formatter(function (str) {
		if (str === ' ') {
			ruler.text('I am');
			var withSpace = ruler.width();
			ruler.text('Iam');
			return withSpace - ruler.width();
		}
		return ruler.text(str).width();
	});

	function browserAssistTypeset(identifier, text, type, lineLengths, tolerance) {
		var nodes = format[type](text),
			breaks = Typeset.linebreak(nodes, lineLengths, {tolerance: tolerance}),
			lines = [],
			i, point, r, lineStart = 0,
			browserAssist = $(identifier).after('<ul></ul>'),
			browserAssistRatio = $(identifier + ' + ul');

		lineWidth = lineLengths[0];

		// Iterate through the line breaks, and split the nodes at the
		// correct point.
		for (i = 1; i < breaks.length; i += 1) {
			point = breaks[i].position,
			r = breaks[i].ratio;

			for (var j = lineStart; j < nodes.length; j += 1) {
				// After a line break, we skip any nodes unless they are boxes or forced breaks.
				if (nodes[j].type === 'box' || (nodes[j].type === 'penalty' && nodes[j].penalty === -Typeset.linebreak.infinity)) {
					lineStart = j;
					break;
				}
			}
			lines.push({ratio: r, nodes: nodes.slice(lineStart, point + 1), position: point});
			lineStart = point;
		}

		lines.forEach(function (line, lineIndex, lineArray) {
			var hyphenPenalty = 100,
				words = [],
				current = '',
				lineText,
				isLastLine = lineIndex === lineArray.length - 1,
				gaps,
				wordSpace = 0;

			line.nodes.forEach(function (n, index, array) {
				if (n.type === 'box') {
					current += n.value;
				} else if (n.type === 'glue' && index !== array.length - 1) {
					if (current) {
						words.push(current);
						current = '';
					}
				} else if (n.type === 'penalty' && n.penalty === hyphenPenalty && index === array.length - 1) {
					current += '-';
				}
			});

			if (current) {
				words.push(current);
			}

			lineText = words.join(' ');
			gaps = (lineText.match(/ /g) || []).length;

			if (!isLastLine && gaps > 0) {
				ruler.text(lineText);
				wordSpace = (lineWidth - ruler.width()) / gaps;
			}

			var output = '<span style="display: block; white-space: nowrap; word-spacing: ' + wordSpace.toFixed(3) + 'px;">' + lineText + '</span>';
			browserAssist.append(output);
			browserAssistRatio.append('<li>' + line.ratio.toFixed(3) + '</li>');
		});
	}
	browserAssistTypeset('#browser-assist', text, 'justify', [350], 3);
});
