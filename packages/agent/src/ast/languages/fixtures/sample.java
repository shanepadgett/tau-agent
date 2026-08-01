package com.demo;

import java.util.List;
import java.util.ArrayList;

/** Greeter type. */
public class Greeter implements Named {
	private int count;
	public static final int MAX = 10;

	public Greeter() {}

	public Greeter(String name) {
		this.count = name.length();
	}

	public void hello() {
		count += 1;
	}

	@Override
	public void name() {}
}

interface Named {
	void name();
}

enum Color {
	RED,
	GREEN;

	void paint() {}
}

record Point(int x, int y) {}

@interface Internal {
	String value() default "";
}
