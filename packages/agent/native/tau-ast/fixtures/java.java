package fixture;

interface Parser {
    Result parse(String source);
}

final class Result {
    final boolean ok;

    Result(boolean ok) {
        this.ok = ok;
    }
}

final class FileParser implements Parser {
    @Override
    public Result parse(String source) {
        return new Result(!source.trim().isEmpty());
    }
}
