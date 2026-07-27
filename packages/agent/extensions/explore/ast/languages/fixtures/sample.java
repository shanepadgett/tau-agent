package com.demo;

import java.util.List;

/** Greeter type. */
public class Greeter {
    private int count;
    public Greeter() {}
    public void hello() {}
    public static final int MAX = 10;
}

interface Named {
    void name();
}

enum Color {
    RED,
    GREEN;
    void paint() {}
}
