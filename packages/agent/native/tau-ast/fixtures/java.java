package fixture;

import java.io.IOException;
import java.time.*;
import java.util.List;
import java.util.Map;
import java.util.Set;
import static java.util.Collections.emptyList;
import static java.util.Map.entry;

/** Parses source values. */
public interface Parser<T extends CharSequence> {
    int DEFAULT_LIMIT = 10;

    Result parse(T source) throws IOException;

    default List<T> emptyValues() {
        return emptyList();
    }

    private void reset() {}

    class Nested {
        public String name() {
            return "nested";
        }

        private void hidden() {}
    }
}

record Result(boolean ok, String message) {
    public Result {
        message = message.trim();
    }

    private static String hidden() {
        return "hidden";
    }
}

record Arguments(String first, String... rest) {}

enum State {
    READY,
    FAILED(1) {
        @Override
        public int code() {
            return 2;
        }
    };

    private final int code;

    State() {
        this(0);
    }

    State(int code) {
        this.code = code;
    }

    public int code() {
        return code;
    }
}

enum Action {
    RUN(() -> {
        System.out.println("hidden lambda body");
    }),
    CALL(() -> System.out.println("hidden expression body"));

    Action(Runnable action) {}
}

enum Empty {
    ;

    public void run() {}
}

@interface Marker {
    String value() default "fixture";
}

final class FileParser implements Parser<String> {
    public static final Map<String, Integer> CODES = Map.ofEntries(entry("ok", 1));
    private String source;
    int packageCount, otherCount = 2;

    static {
        Set.of();
    }

    {
        source = "";
    }

    FileParser(String source) {
        this.source = source;
    }

    /** Parses one source value. */
    @Override
    public Result parse(
        String source
    ) throws IOException {
        return new Result(!source.trim().isEmpty(), source);
    }

    protected void inheritedHook() {}

    private void hidden() {}
}
