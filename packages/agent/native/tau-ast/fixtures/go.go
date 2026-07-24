package fixture

import "strings"

type Parser interface {
	Parse(source string) Result
}

type Result struct {
	OK bool
}

type FileParser struct {
	source string
}

func (parser *FileParser) Parse(source string) Result {
	parser.source = strings.TrimSpace(source)
	return Result{OK: parser.source != ""}
}

func NewParser() Parser {
	return &FileParser{}
}

func hiddenParser() Parser {
	return &FileParser{}
}
