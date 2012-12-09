function dataInputStreamReadLines(dataIn, cancellable) {
    let result = [];
    while (true) {
	let [line, len] = dataIn.read_line_utf8(cancellable);
	if (line == null)
	    break;
	result.push(line);
    }
    return result;
}
