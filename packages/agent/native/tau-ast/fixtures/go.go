package fixture

import (
	_ "embed"
	. "math"
	stringsAlias "strings"
)

import unusedAlias "bytes"

// DefaultLimit is used by parsers.
const (
	DefaultLimit = 10
	// hiddenLimit is package-private.
	hiddenLimit  = 2
	InheritedLimit
)

var (
	Names, Aliases []string
	hiddenNames    = []string{"tau"}
	Handler        = func() string { var ExportedLocal int; return "hidden body" }
	Handlers       = []func(){func() { println("first body") }, func() { println("second body") }}
)

type Value = string

type (
	// Grouped documents a grouped type.
	Grouped struct{}
)

type Pair[T comparable] struct {
	Left, Right T
	*Result
	Box[string]
}

// Parser parses source text.
type Parser interface {
	Parse(source string) Result
	Result
	~int | ~string
}

type Result struct {
	OK      bool // trailing status
	message string
}

type FileParser struct {
	source string
}

func (parser *FileParser) Parse(source string) Result {
	parser.source = stringsAlias.TrimSpace(source)
	return Result{OK: parser.source != ""}
}

func (parser FileParser) Magnitude(value float64) float64 {
	return Sqrt(value)
}

func NewParser() Parser {
	return &FileParser{}
}

func hiddenParser() Parser {
	return &FileParser{}
}

func init() {
	hiddenNames = append(hiddenNames, "ready")
}
