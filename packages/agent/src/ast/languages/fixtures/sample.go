package demo

import (
	"fmt"
	"io"
)

// Greeter greets callers.
type Greeter struct {
	Name string
	count int
}

// Hello prints a greeting.
func (g *Greeter) Hello() {
	fmt.Println("hi", g.Name)
}

type Writer interface {
	io.Writer
	Flush() error
}

type Color int

const (
	Red Color = iota
	Green
)

var DefaultName = "world"

func NewGreeter(name string) *Greeter {
	return &Greeter{Name: name}
}

func hidden() {}
